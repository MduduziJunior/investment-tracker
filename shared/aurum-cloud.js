(() => {
  "use strict";

  /*
   * ============================================================
   * AURUM IMPERIUM INVESTMENT TRACKER
   * SHARED CLOUD ENGINE
   * ============================================================
   *
   * Responsibilities:
   *
   * - Initialise Supabase
   * - Authentication/session access
   * - Profile loading
   * - Per-device identity
   * - Module state cloud save/load
   * - Record-level save/load
   * - localStorage offline cache
   * - Offline write queue
   * - Automatic reconnect sync
   * - Revision/conflict protection
   * - Module settings
   * - Monthly/quarterly/yearly snapshots
   * - Schema compatibility
   * - Cloud backup foundation
   * - Sync diagnostics
   * - Future module compatibility
   *
   * IMPORTANT:
   *
   * This file contains NO Supabase credentials.
   * Credentials live in:
   *
   * shared/supabase-config.js
   *
   * ============================================================
   */


  // ============================================================
  // CONFIGURATION
  // ============================================================

  const CONFIG = window.AURUM_SUPABASE_CONFIG;

  if (!CONFIG) {
    throw new Error(
      "Aurum Cloud: supabase-config.js must load before aurum-cloud.js"
    );
  }


  // ============================================================
  // INTERNAL STATE
  // ============================================================

  const INTERNAL = {

    client: null,

    initialized: false,
    initializing: null,

    session: null,
    user: null,
    profile: null,

    deviceId: null,

    online:
      typeof navigator === "undefined"
        ? true
        : navigator.onLine !== false,

    syncing: false,

    lastSync: null,
    lastError: null,

    authSubscription: null,

    listenersAttached: false,

    autoSaveTimers: new Map()

  };


  // ============================================================
  // GENERAL UTILITIES
  // ============================================================

  function nowISO() {
    return new Date().toISOString();
  }


  function safeParse(value, fallback = null) {

    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      return fallback;
    }

    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }

  }


  function clone(value) {

    if (value === undefined) {
      return undefined;
    }

    if (
      typeof structuredClone === "function"
    ) {
      try {
        return structuredClone(value);
      } catch {
        // Fall through.
      }
    }

    return JSON.parse(
      JSON.stringify(value)
    );

  }


  function randomId(prefix = "id") {

    if (
      window.crypto &&
      typeof window.crypto.randomUUID === "function"
    ) {
      return `${prefix}_${window.crypto.randomUUID()}`;
    }

    return (
      prefix +
      "_" +
      Date.now().toString(36) +
      "_" +
      Math.random()
        .toString(36)
        .slice(2, 12)
    );

  }


  function cleanText(value) {

    return String(value ?? "")
      .trim();

  }


  function requireText(value, name) {

    const result = cleanText(value);

    if (!result) {
      throw new Error(
        `Aurum Cloud: ${name} is required.`
      );
    }

    return result;

  }


  function isNetworkError(error) {

    if (!error) {
      return false;
    }

    if (
      typeof navigator !== "undefined" &&
      navigator.onLine === false
    ) {
      return true;
    }

    const message =
      String(
        error.message ||
        error.error_description ||
        error
      ).toLowerCase();

    return (
      message.includes("failed to fetch") ||
      message.includes("networkerror") ||
      message.includes("network error") ||
      message.includes("load failed") ||
      message.includes("fetch failed") ||
      message.includes("connection")
    );

  }


  function isRevisionConflict(error) {

    if (!error) {
      return false;
    }

    const message =
      String(
        error.message ||
        error.details ||
        error
      );

    return message.includes(
      "REVISION_CONFLICT"
    );

  }


  function normaliseSupabaseRow(data) {

    if (!data) {
      return null;
    }

    if (Array.isArray(data)) {
      return data[0] || null;
    }

    return data;

  }


  function getSupabaseSDK() {

    if (
      !window.supabase ||
      typeof window.supabase.createClient !== "function"
    ) {
      throw new Error(
        "Aurum Cloud: Supabase JavaScript library is not loaded."
      );
    }

    return window.supabase;

  }


  // ============================================================
  // LOCAL STORAGE HELPERS
  // ============================================================

  function safeLocalGet(key) {

    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }

  }


  function safeLocalSet(
    key,
    value
  ) {

    try {

      localStorage.setItem(
        key,
        value
      );

      return true;

    } catch (error) {

      INTERNAL.lastError = error;

      emit(
        "local-storage-error",
        {
          key,
          error: String(
            error?.message || error
          )
        }
      );

      return false;

    }

  }


  function safeLocalRemove(key) {

    try {
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }

  }


  // ============================================================
  // DEVICE IDENTITY
  // ============================================================

  function getDeviceId() {

    if (INTERNAL.deviceId) {
      return INTERNAL.deviceId;
    }

    let deviceId =
      safeLocalGet(
        CONFIG.LOCAL_KEYS.DEVICE_ID
      );

    if (!deviceId) {

      deviceId =
        randomId("device");

      safeLocalSet(
        CONFIG.LOCAL_KEYS.DEVICE_ID,
        deviceId
      );

    }

    INTERNAL.deviceId =
      deviceId;

    return deviceId;

  }


  function getDeviceMetadata() {

    return {

      device_id:
        getDeviceId(),

      platform:
        navigator.platform || null,

      browser:
        navigator.userAgent || null,

      app_version:
        CONFIG.APP_VERSION,

      supported_schema_versions: {
        app:
          CONFIG.APP_SCHEMA_VERSION,
        contract:
          CONFIG.CLOUD_CONTRACT_VERSION
      },

      capabilities: {
        localStorage: true,
        online:
          navigator.onLine !== false,
        storageEvidence: true,
        offlineQueue: true,
        revisionProtection: true
      },

      metadata: {
        language:
          navigator.language || null
      },

      last_seen_at:
        nowISO()

    };

  }


  // ============================================================
  // USER-SCOPED LOCAL CACHE KEYS
  // ============================================================

  function requireUserId() {

    const id =
      INTERNAL.user?.id;

    if (!id) {
      throw new Error(
        "Aurum Cloud: authenticated user required."
      );
    }

    return id;

  }


  function moduleCacheKey(
    userId,
    moduleName
  ) {

    return (
      `${CONFIG.LOCAL_PREFIX}` +
      `:module:${userId}:${moduleName}`
    );

  }


  function recordCacheKey(
    userId,
    moduleName,
    recordType,
    recordId
  ) {

    return (
      `${CONFIG.LOCAL_PREFIX}` +
      `:record:${userId}` +
      `:${moduleName}` +
      `:${recordType}` +
      `:${recordId}`
    );

  }


  function recordIndexKey(
    userId,
    moduleName,
    recordType
  ) {

    return (
      `${CONFIG.LOCAL_PREFIX}` +
      `:record-index:${userId}` +
      `:${moduleName}` +
      `:${recordType}`
    );

  }


  function queueKey(userId) {

    return (
      `${CONFIG.LOCAL_KEYS.SYNC_QUEUE}` +
      `:${userId}`
    );

  }


  function lastSyncKey(userId) {

    return (
      `${CONFIG.LOCAL_KEYS.LAST_SYNC}` +
      `:${userId}`
    );

  }


  // ============================================================
  // EVENT SYSTEM
  // ============================================================

  function getQueueLength() {

    if (!INTERNAL.user?.id) {
      return 0;
    }

    return getQueue(
      INTERNAL.user.id
    ).length;

  }


  function getStatus() {

    return {

      initialized:
        INTERNAL.initialized,

      online:
        INTERNAL.online,

      authenticated:
        Boolean(
          INTERNAL.user?.id
        ),

      userId:
        INTERNAL.user?.id || null,

      username:
        INTERNAL.profile?.username || null,

      deviceId:
        getDeviceId(),

      syncing:
        INTERNAL.syncing,

      queuedChanges:
        getQueueLength(),

      lastSync:
        INTERNAL.lastSync,

      lastError:
        INTERNAL.lastError
          ? String(
              INTERNAL.lastError.message ||
              INTERNAL.lastError
            )
          : null

    };

  }


  function emit(
    type,
    detail = {}
  ) {

    const payload = {
      ...getStatus(),
      ...detail
    };

    try {

      window.dispatchEvent(
        new CustomEvent(
          `aurum-cloud:${type}`,
          {
            detail: payload
          }
        )
      );

    } catch {
      // Ignore UI event failures.
    }

  }


  // ============================================================
  // MODULE LOCAL CACHE
  // ============================================================

  function readModuleCache(
    userId,
    moduleName
  ) {

    return safeParse(
      safeLocalGet(
        moduleCacheKey(
          userId,
          moduleName
        )
      ),
      null
    );

  }


  function writeModuleCache(
    userId,
    moduleName,
    envelope
  ) {

    return safeLocalSet(
      moduleCacheKey(
        userId,
        moduleName
      ),
      JSON.stringify(
        envelope
      )
    );

  }


  // ============================================================
  // RECORD LOCAL CACHE
  // ============================================================

  function readRecordIndex(
    userId,
    moduleName,
    recordType
  ) {

    return safeParse(
      safeLocalGet(
        recordIndexKey(
          userId,
          moduleName,
          recordType
        )
      ),
      []
    ) || [];

  }


  function writeRecordIndex(
    userId,
    moduleName,
    recordType,
    ids
  ) {

    return safeLocalSet(
      recordIndexKey(
        userId,
        moduleName,
        recordType
      ),
      JSON.stringify(
        Array.from(
          new Set(ids)
        )
      )
    );

  }


  function writeRecordCache(
    userId,
    moduleName,
    recordType,
    recordId,
    envelope
  ) {

    safeLocalSet(
      recordCacheKey(
        userId,
        moduleName,
        recordType,
        recordId
      ),
      JSON.stringify(
        envelope
      )
    );


    const index =
      readRecordIndex(
        userId,
        moduleName,
        recordType
      );


    if (
      !index.includes(recordId)
    ) {

      index.push(recordId);

      writeRecordIndex(
        userId,
        moduleName,
        recordType,
        index
      );

    }

  }


  function readRecordCache(
    userId,
    moduleName,
    recordType,
    recordId
  ) {

    return safeParse(
      safeLocalGet(
        recordCacheKey(
          userId,
          moduleName,
          recordType,
          recordId
        )
      ),
      null
    );

  }


  // ============================================================
  // OFFLINE QUEUE
  // ============================================================

  function getQueue(userId) {

    return safeParse(
      safeLocalGet(
        queueKey(userId)
      ),
      []
    ) || [];

  }


  function saveQueue(
    userId,
    queue
  ) {

    safeLocalSet(
      queueKey(userId),
      JSON.stringify(queue)
    );

    emit(
      "queue-changed",
      {
        queuedChanges:
          queue.length
      }
    );

  }


  function operationIdentity(op) {

    switch (op.kind) {

      case "module-state":
        return (
          `module-state:` +
          `${op.moduleName}`
        );

      case "module-record":
        return (
          `module-record:` +
          `${op.moduleName}:` +
          `${op.recordType}:` +
          `${op.recordId}`
        );

      case "setting":
        return (
          `setting:` +
          `${op.moduleName}:` +
          `${op.settingKey}`
        );

      case "snapshot":
        return (
          `snapshot:` +
          `${op.moduleName}:` +
          `${op.periodType}:` +
          `${op.periodStart}:` +
          `${op.periodEnd}:` +
          `${op.snapshotType}:` +
          `${op.reportingCurrency}:` +
          `${op.calculationVersion}`
        );

      default:
        return op.id;

    }

  }


  function enqueueOperation(op) {

    const userId =
      requireUserId();

    const queue =
      getQueue(userId);

    const identity =
      operationIdentity(op);


    const existingIndex =
      queue.findIndex(
        item =>
          operationIdentity(item) ===
          identity
      );


    if (existingIndex >= 0) {

      const previous =
        queue[existingIndex];

      /*
       * Keep the ORIGINAL expected revision.
       *
       * Example:
       *
       * Cloud revision = 5
       *
       * Offline edit A
       * Offline edit B
       * Offline edit C
       *
       * All three edits still descend from cloud revision 5.
       */

      queue[existingIndex] = {

        ...previous,
        ...clone(op),

        id:
          previous.id,

        expectedRevision:
          previous.expectedRevision,

        queuedAt:
          previous.queuedAt,

        updatedAt:
          nowISO()

      };

    } else {

      queue.push({

        id:
          randomId("sync"),

        userId,

        queuedAt:
          nowISO(),

        attempts: 0,

        ...clone(op)

      });

    }


    saveQueue(
      userId,
      queue
    );

    return queue.length;

  }


  // ============================================================
  // SUPABASE CLIENT INITIALISATION
  // ============================================================

  async function initialize() {

    if (
      INTERNAL.initialized
    ) {
      return API;
    }


    if (
      INTERNAL.initializing
    ) {
      return INTERNAL.initializing;
    }


    INTERNAL.initializing =
      (async () => {

        const validation =
          typeof window
            .AURUM_VALIDATE_SUPABASE_CONFIG ===
          "function"
            ? window
                .AURUM_VALIDATE_SUPABASE_CONFIG()
            : {
                valid: true,
                errors: []
              };


        if (!validation.valid) {

          throw new Error(
            validation.errors.join(" ")
          );

        }


        const sdk =
          getSupabaseSDK();


        INTERNAL.client =
          sdk.createClient(
            CONFIG.SUPABASE_URL,
            CONFIG.SUPABASE_PUBLISHABLE_KEY,
            {
              auth: {

                persistSession: true,

                autoRefreshToken: true,

                detectSessionInUrl: true,

                storageKey:
                  `${CONFIG.LOCAL_PREFIX}_auth`

              }
            }
          );


        const {
          data,
          error
        } =
          await INTERNAL.client
            .auth
            .getSession();


        if (error) {
          throw error;
        }


        INTERNAL.session =
          data?.session || null;

        INTERNAL.user =
          data?.session?.user || null;


        INTERNAL.lastSync =
          INTERNAL.user?.id
            ? safeLocalGet(
                lastSyncKey(
                  INTERNAL.user.id
                )
              )
            : null;


        attachBrowserListeners();

        attachAuthListener();


        INTERNAL.initialized = true;


        if (
          INTERNAL.user?.id
        ) {

          await loadProfile()
            .catch(() => null);

          await registerInstallation()
            .catch(() => null);

        }


        emit(
          "ready"
        );


        if (
          INTERNAL.online &&
          INTERNAL.user?.id
        ) {

          setTimeout(
            () => {
              flushQueue()
                .catch(() => null);
            },
            0
          );

        }


        return API;

      })();


    try {

      return await
        INTERNAL.initializing;

    } finally {

      INTERNAL.initializing =
        null;

    }

  }


  function requireClient() {

    if (!INTERNAL.client) {

      throw new Error(
        "Aurum Cloud has not been initialised."
      );

    }

    return INTERNAL.client;

  }


  // ============================================================
  // AUTH STATE
  // ============================================================

  function attachAuthListener() {

    if (
      INTERNAL.authSubscription
    ) {
      return;
    }


    const client =
      requireClient();


    const result =
      client.auth
        .onAuthStateChange(
          (
            event,
            session
          ) => {

            /*
             * Supabase recommends avoiding complex awaited
             * Supabase calls directly inside this callback.
             */

            setTimeout(
              async () => {

                INTERNAL.session =
                  session || null;

                INTERNAL.user =
                  session?.user || null;

                INTERNAL.profile =
                  null;


                if (
                  INTERNAL.user?.id
                ) {

                  INTERNAL.lastSync =
                    safeLocalGet(
                      lastSyncKey(
                        INTERNAL.user.id
                      )
                    );


                  await loadProfile()
                    .catch(() => null);

                  await registerInstallation()
                    .catch(() => null);


                  if (
                    INTERNAL.online
                  ) {

                    flushQueue()
                      .catch(() => null);

                  }

                }


                emit(
                  "auth-changed",
                  {
                    authEvent:
                      event
                  }
                );

              },
              0
            );

          }
        );


    INTERNAL.authSubscription =
      result?.data?.subscription ||
      null;

  }


  // ============================================================
  // BROWSER ONLINE / OFFLINE EVENTS
  // ============================================================

  function attachBrowserListeners() {

    if (
      INTERNAL.listenersAttached
    ) {
      return;
    }


    window.addEventListener(
      "online",
      () => {

        INTERNAL.online = true;

        emit(
          "online"
        );


        if (
          INTERNAL.user?.id
        ) {

          flushQueue()
            .catch(
              error => {
                INTERNAL.lastError =
                  error;

                emit(
                  "sync-error",
                  {
                    error:
                      String(
                        error?.message ||
                        error
                      )
                  }
                );
              }
            );

        }

      }
    );


    window.addEventListener(
      "offline",
      () => {

        INTERNAL.online =
          false;

        emit(
          "offline"
        );

      }
    );


    INTERNAL.listenersAttached =
      true;

  }


  // ============================================================
  // AUTH API
  // ============================================================

  async function signUp({
    email,
    password,
    username,
    displayName
  }) {

    await initialize();


    email =
      requireText(
        email,
        "email"
      );

    password =
      requireText(
        password,
        "password"
      );

    username =
      requireText(
        username,
        "username"
      );


    const {
      data,
      error
    } =
      await INTERNAL.client
        .auth
        .signUp({

          email,

          password,

          options: {

            data: {

              username,

              display_name:
                cleanText(
                  displayName
                ) || username

            }

          }

        });


    if (error) {
      throw error;
    }


    return data;

  }


  async function signIn({
    email,
    password
  }) {

    await initialize();


    const {
      data,
      error
    } =
      await INTERNAL.client
        .auth
        .signInWithPassword({

          email:
            requireText(
              email,
              "email"
            ),

          password:
            requireText(
              password,
              "password"
            )

        });


    if (error) {
      throw error;
    }


    return data;

  }


  async function signOut() {

    await initialize();


    const {
      error
    } =
      await INTERNAL.client
        .auth
        .signOut({
          scope: "local"
        });


    if (error) {
      throw error;
    }


    INTERNAL.session =
      null;

    INTERNAL.user =
      null;

    INTERNAL.profile =
      null;

    INTERNAL.lastSync =
      null;


    emit(
      "signed-out"
    );


    return true;

  }


  function getSession() {
    return INTERNAL.session;
  }


  function getUser() {
    return INTERNAL.user;
  }


  // ============================================================
  // PROFILE
  // ============================================================

  async function loadProfile() {

    await initialize();


    const userId =
      requireUserId();


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES.PROFILE
        )
        .select("*")
        .eq(
          "user_id",
          userId
        )
        .maybeSingle();


    if (error) {
      throw error;
    }


    if (data) {

      INTERNAL.profile =
        data;

      emit(
        "profile-loaded"
      );

      return clone(data);

    }


    /*
     * Normally the database signup trigger creates this row.
     *
     * This is only a safety fallback.
     */

    const username =
      INTERNAL.user
        ?.user_metadata
        ?.username ||
      `user_${userId.slice(0, 8)}`;


    const displayName =
      INTERNAL.user
        ?.user_metadata
        ?.display_name ||
      username;


    const {
      data: created,
      error: createError
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES.PROFILE
        )
        .upsert(
          {
            user_id:
              userId,

            username,

            display_name:
              displayName
          },
          {
            onConflict:
              "user_id"
          }
        )
        .select("*")
        .single();


    if (createError) {
      throw createError;
    }


    INTERNAL.profile =
      created;


    return clone(created);

  }


  function getProfile() {
    return clone(
      INTERNAL.profile
    );
  }


  // ============================================================
  // CLIENT INSTALLATION
  // ============================================================

  async function registerInstallation() {

    await initialize();


    const userId =
      requireUserId();


    if (!INTERNAL.online) {
      return null;
    }


    const metadata =
      getDeviceMetadata();


    const row = {

      user_id:
        userId,

      ...metadata

    };


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .CLIENT_INSTALLATIONS
        )
        .upsert(
          row,
          {
            onConflict:
              "user_id,device_id"
          }
        )
        .select("*")
        .single();


    if (error) {
      throw error;
    }


    return data;

  }


  // ============================================================
  // SYNC EVENT LOGGING
  // ============================================================

  async function logSyncEvent({
    moduleName = null,
    eventType,
    status = null,
    revision = null,
    details = {}
  }) {

    if (
      !INTERNAL.online ||
      !INTERNAL.user?.id ||
      !INTERNAL.client
    ) {
      return null;
    }


    try {

      const {
        data,
        error
      } =
        await INTERNAL.client
          .from(
            CONFIG.TABLES.SYNC_EVENTS
          )
          .insert({

            user_id:
              INTERNAL.user.id,

            module_name:
              moduleName,

            device_id:
              getDeviceId(),

            event_type:
              eventType,

            status,

            revision,

            details,

            client_time:
              nowISO()

          })
          .select("*")
          .single();


      if (error) {
        return null;
      }


      return data;

    } catch {

      return null;

    }

  }


  // ============================================================
  // CONFLICT RECORDING
  // ============================================================

  async function recordConflict(
    operation,
    error
  ) {

    if (
      !INTERNAL.online ||
      !INTERNAL.user?.id
    ) {
      return null;
    }


    let cloudPayload =
      null;

    let cloudRevision =
      null;


    try {

      if (
        operation.kind ===
        "module-state"
      ) {

        const {
          data
        } =
          await INTERNAL.client
            .from(
              CONFIG.TABLES
                .MODULE_STATE
            )
            .select(
              "state,revision"
            )
            .eq(
              "module_name",
              operation.moduleName
            )
            .maybeSingle();


        cloudPayload =
          data?.state || null;

        cloudRevision =
          data?.revision || null;

      }


      if (
        operation.kind ===
        "module-record"
      ) {

        const {
          data
        } =
          await INTERNAL.client
            .from(
              CONFIG.TABLES
                .MODULE_RECORDS
            )
            .select(
              "payload,revision"
            )
            .eq(
              "module_name",
              operation.moduleName
            )
            .eq(
              "record_type",
              operation.recordType
            )
            .eq(
              "record_id",
              operation.recordId
            )
            .maybeSingle();


        cloudPayload =
          data?.payload || null;

        cloudRevision =
          data?.revision || null;

      }

    } catch {
      // Conflict record can still be created.
    }


    try {

      const {
        data
      } =
        await INTERNAL.client
          .from(
            CONFIG.TABLES
              .SYNC_CONFLICTS
          )
          .insert({

            user_id:
              INTERNAL.user.id,

            module_name:
              operation.moduleName,

            record_type:
              operation.recordType ||
              null,

            record_id:
              operation.recordId ||
              null,

            local_revision:
              operation.expectedRevision ??
              null,

            cloud_revision:
              cloudRevision,

            local_payload:
              operation.state ||
              operation.payload ||
              null,

            cloud_payload:
              cloudPayload,

            resolution_status:
              "unresolved",

            resolution_note:
              String(
                error?.message ||
                error
              )

          })
          .select("*")
          .single();


      emit(
        "conflict",
        {
          moduleName:
            operation.moduleName,

          recordId:
            operation.recordId ||
            null
        }
      );


      return data;

    } catch {

      return null;

    }

  }


  // ============================================================
  // MODULE STATE — LOCAL STAGING
  // ============================================================

  function stageModuleState(
    moduleName,
    state,
    options = {}
  ) {

    const userId =
      requireUserId();


    moduleName =
      requireText(
        moduleName,
        "moduleName"
      );


    const existing =
      readModuleCache(
        userId,
        moduleName
      );


    const baseRevision =
      existing?.dirty
        ? (
            existing.baseRevision ??
            existing.revision ??
            0
          )
        : (
            existing?.revision ??
            0
          );


    const envelope = {

      moduleName,

      schemaVersion:
        options.schemaVersion ||
        CONFIG.APP_SCHEMA_VERSION,

      state:
        clone(state),

      revision:
        existing?.revision ||
        baseRevision ||
        0,

      baseRevision,

      dirty: true,

      updatedAt:
        nowISO(),

      lastCloudSync:
        existing?.lastCloudSync ||
        null

    };


    writeModuleCache(
      userId,
      moduleName,
      envelope
    );


    enqueueOperation({

      kind:
        "module-state",

      moduleName,

      schemaVersion:
        envelope.schemaVersion,

      state:
        envelope.state,

      expectedRevision:
        baseRevision,

      clientUpdatedAt:
        envelope.updatedAt,

      deviceId:
        getDeviceId(),

      appVersion:
        CONFIG.APP_VERSION

    });


    emit(
      "local-save",
      {
        moduleName,
        dirty: true
      }
    );


    return clone(envelope);

  }


  // ============================================================
  // MODULE STATE — CLOUD PROCESSOR
  // ============================================================

  async function processModuleStateOperation(
    operation
  ) {

    const {
      data,
      error
    } =
      await INTERNAL.client
        .rpc(
          CONFIG.RPC
            .SAVE_MODULE_STATE,
          {

            p_module_name:
              operation.moduleName,

            p_schema_version:
              operation.schemaVersion,

            p_state:
              operation.state,

            p_expected_revision:
              operation.expectedRevision,

            p_client_updated_at:
              operation.clientUpdatedAt,

            p_device_id:
              operation.deviceId,

            p_app_version:
              operation.appVersion

          }
        );


    if (error) {
      throw error;
    }


    const row =
      normaliseSupabaseRow(
        data
      );


    if (!row) {

      throw new Error(
        "Cloud save returned no module state."
      );

    }


    const userId =
      requireUserId();


    writeModuleCache(
      userId,
      operation.moduleName,
      {

        moduleName:
          operation.moduleName,

        schemaVersion:
          row.schema_version,

        state:
          clone(row.state),

        revision:
          row.revision,

        baseRevision:
          row.revision,

        dirty: false,

        updatedAt:
          row.updated_at,

        lastCloudSync:
          row.last_synced_at ||
          nowISO()

      }
    );


    return row;

  }


  // ============================================================
  // MODULE STATE — SAVE
  // ============================================================

  async function saveModuleState(
    moduleName,
    state,
    options = {}
  ) {

    await initialize();

    requireUserId();


    stageModuleState(
      moduleName,
      state,
      options
    );


    if (!INTERNAL.online) {

      emit(
        "queued-offline",
        {
          moduleName
        }
      );

      return {
        queued: true,
        offline: true
      };

    }


    await flushQueue();


    const cache =
      readModuleCache(
        INTERNAL.user.id,
        moduleName
      );


    return {

      queued:
        Boolean(
          cache?.dirty
        ),

      offline: false,

      revision:
        cache?.revision || null,

      state:
        clone(
          cache?.state
        )

    };

  }


  // ============================================================
  // MODULE STATE — AUTO SAVE
  // ============================================================

  function autoSaveModuleState(
    moduleName,
    state,
    options = {}
  ) {

    if (
      !INTERNAL.user?.id
    ) {
      throw new Error(
        "Aurum Cloud: login required before auto-save."
      );
    }


    stageModuleState(
      moduleName,
      state,
      options
    );


    const delay =
      Number(
        options.delayMs
      ) || 800;


    const existingTimer =
      INTERNAL.autoSaveTimers
        .get(moduleName);


    if (existingTimer) {

      clearTimeout(
        existingTimer
      );

    }


    const timer =
      setTimeout(
        async () => {

          INTERNAL.autoSaveTimers
            .delete(
              moduleName
            );


          if (
            INTERNAL.online
          ) {

            try {
              await flushQueue();
            } catch {
              // Queue remains for retry.
            }

          }

        },
        delay
      );


    INTERNAL.autoSaveTimers
      .set(
        moduleName,
        timer
      );


    return {
      staged: true
    };

  }


  // ============================================================
  // MODULE STATE — LOAD
  // ============================================================

  async function loadModuleState(
    moduleName,
    options = {}
  ) {

    await initialize();


    const userId =
      requireUserId();


    moduleName =
      requireText(
        moduleName,
        "moduleName"
      );


    let local =
      readModuleCache(
        userId,
        moduleName
      );


    /*
     * If local data has unsynced changes,
     * never blindly overwrite it with cloud data.
     */

    if (
      local?.dirty &&
      INTERNAL.online
    ) {

      try {

        await flushQueue();

        local =
          readModuleCache(
            userId,
            moduleName
          );

      } catch {
        // Local copy remains protected.
      }

    }


    if (
      local?.dirty
    ) {

      return {

        source:
          "local-unsynced",

        ...clone(local)

      };

    }


    if (
      !INTERNAL.online
    ) {

      return local
        ? {
            source:
              "local-offline",

            ...clone(local)
          }
        : null;

    }


    try {

      const {
        data,
        error
      } =
        await INTERNAL.client
          .from(
            CONFIG.TABLES
              .MODULE_STATE
          )
          .select("*")
          .eq(
            "module_name",
            moduleName
          )
          .maybeSingle();


      if (error) {
        throw error;
      }


      if (!data) {

        return local
          ? {
              source:
                "local",

              ...clone(local)
            }
          : null;

      }


      const envelope = {

        moduleName,

        schemaVersion:
          data.schema_version,

        state:
          clone(data.state),

        revision:
          data.revision,

        baseRevision:
          data.revision,

        dirty: false,

        updatedAt:
          data.updated_at,

        lastCloudSync:
          data.last_synced_at ||
          nowISO()

      };


      writeModuleCache(
        userId,
        moduleName,
        envelope
      );


      return {

        source:
          "cloud",

        ...clone(envelope)

      };

    } catch (error) {

      if (
        isNetworkError(error) &&
        local
      ) {

        return {

          source:
            "local-fallback",

          ...clone(local)

        };

      }


      throw error;

    }

  }


  // ============================================================
  // RECORD — LOCAL STAGING
  // ============================================================

  function stageModuleRecord(
    moduleName,
    recordType,
    recordId,
    payload,
    options = {}
  ) {

    const userId =
      requireUserId();


    moduleName =
      requireText(
        moduleName,
        "moduleName"
      );

    recordType =
      requireText(
        recordType,
        "recordType"
      );

    recordId =
      requireText(
        recordId,
        "recordId"
      );


    const existing =
      readRecordCache(
        userId,
        moduleName,
        recordType,
        recordId
      );


    const baseRevision =
      existing?.dirty
        ? (
            existing.baseRevision ??
            existing.revision ??
            0
          )
        : (
            existing?.revision ??
            0
          );


    const envelope = {

      moduleName,

      recordType,

      recordId,

      schemaVersion:
        options.schemaVersion ||
        CONFIG.APP_SCHEMA_VERSION,

      payload:
        clone(payload),

      revision:
        existing?.revision ||
        baseRevision ||
        0,

      baseRevision,

      dirty: true,

      deletedAt:
        options.deletedAt ||
        null,

      updatedAt:
        nowISO()

    };


    writeRecordCache(
      userId,
      moduleName,
      recordType,
      recordId,
      envelope
    );


    enqueueOperation({

      kind:
        "module-record",

      moduleName,

      recordType,

      recordId,

      schemaVersion:
        envelope.schemaVersion,

      payload:
        envelope.payload,

      expectedRevision:
        baseRevision,

      clientUpdatedAt:
        envelope.updatedAt,

      deletedAt:
        envelope.deletedAt,

      deviceId:
        getDeviceId(),

      appVersion:
        CONFIG.APP_VERSION

    });


    return clone(envelope);

  }


  async function processModuleRecordOperation(
    operation
  ) {

    const {
      data,
      error
    } =
      await INTERNAL.client
        .rpc(
          CONFIG.RPC
            .SAVE_MODULE_RECORD,
          {

            p_module_name:
              operation.moduleName,

            p_record_type:
              operation.recordType,

            p_record_id:
              operation.recordId,

            p_schema_version:
              operation.schemaVersion,

            p_payload:
              operation.payload,

            p_expected_revision:
              operation.expectedRevision,

            p_client_updated_at:
              operation.clientUpdatedAt,

            p_device_id:
              operation.deviceId,

            p_app_version:
              operation.appVersion,

            p_deleted_at:
              operation.deletedAt

          }
        );


    if (error) {
      throw error;
    }


    const row =
      normaliseSupabaseRow(
        data
      );


    if (!row) {

      throw new Error(
        "Cloud save returned no module record."
      );

    }


    writeRecordCache(
      requireUserId(),
      operation.moduleName,
      operation.recordType,
      operation.recordId,
      {

        moduleName:
          operation.moduleName,

        recordType:
          operation.recordType,

        recordId:
          operation.recordId,

        schemaVersion:
          row.schema_version,

        payload:
          clone(row.payload),

        revision:
          row.revision,

        baseRevision:
          row.revision,

        dirty: false,

        deletedAt:
          row.deleted_at,

        updatedAt:
          row.updated_at

      }
    );


    return row;

  }


  async function saveModuleRecord(
    moduleName,
    recordType,
    recordId,
    payload,
    options = {}
  ) {

    await initialize();

    requireUserId();


    stageModuleRecord(
      moduleName,
      recordType,
      recordId,
      payload,
      options
    );


    if (!INTERNAL.online) {

      return {
        queued: true,
        offline: true
      };

    }


    await flushQueue();


    const cache =
      readRecordCache(
        INTERNAL.user.id,
        moduleName,
        recordType,
        recordId
      );


    return {

      queued:
        Boolean(
          cache?.dirty
        ),

      revision:
        cache?.revision || null,

      payload:
        clone(
          cache?.payload
        )

    };

  }


  // ============================================================
  // MODULE RECORDS — LOAD
  // ============================================================

  async function loadModuleRecords(
    moduleName,
    recordType,
    options = {}
  ) {

    await initialize();


    const userId =
      requireUserId();


    moduleName =
      requireText(
        moduleName,
        "moduleName"
      );

    recordType =
      requireText(
        recordType,
        "recordType"
      );


    if (!INTERNAL.online) {

      const ids =
        readRecordIndex(
          userId,
          moduleName,
          recordType
        );


      return ids
        .map(
          id =>
            readRecordCache(
              userId,
              moduleName,
              recordType,
              id
            )
        )
        .filter(Boolean)
        .filter(
          item =>
            options.includeDeleted ||
            !item.deletedAt
        )
        .map(
          item => ({
            source:
              "local-offline",
            ...clone(item)
          })
        );

    }


    let query =
      INTERNAL.client
        .from(
          CONFIG.TABLES
            .MODULE_RECORDS
        )
        .select("*")
        .eq(
          "module_name",
          moduleName
        )
        .eq(
          "record_type",
          recordType
        );


    if (
      !options.includeDeleted
    ) {

      query =
        query.is(
          "deleted_at",
          null
        );

    }


    const {
      data,
      error
    } =
      await query
        .order(
          "updated_at",
          {
            ascending: false
          }
        );


    if (error) {
      throw error;
    }


    for (
      const row of
      data || []
    ) {

      writeRecordCache(
        userId,
        moduleName,
        recordType,
        row.record_id,
        {

          moduleName,

          recordType,

          recordId:
            row.record_id,

          schemaVersion:
            row.schema_version,

          payload:
            clone(row.payload),

          revision:
            row.revision,

          baseRevision:
            row.revision,

          dirty: false,

          deletedAt:
            row.deleted_at,

          updatedAt:
            row.updated_at

        }
      );

    }


    return clone(
      data || []
    );

  }


  // ============================================================
  // MODULE SETTINGS
  // ============================================================

  async function saveModuleSetting(
    moduleName,
    settingKey,
    value
  ) {

    await initialize();


    const userId =
      requireUserId();


    moduleName =
      requireText(
        moduleName,
        "moduleName"
      );

    settingKey =
      requireText(
        settingKey,
        "settingKey"
      );


    const operation = {

      kind:
        "setting",

      moduleName,

      settingKey,

      row: {

        user_id:
          userId,

        module_name:
          moduleName,

        setting_key:
          settingKey,

        value:
          clone(value),

        schema_version:
          CONFIG.APP_SCHEMA_VERSION,

        writer_app_version:
          CONFIG.APP_VERSION,

        last_write_device_id:
          getDeviceId()

      }

    };


    enqueueOperation(
      operation
    );


    if (
      INTERNAL.online
    ) {
      await flushQueue();
    }


    return true;

  }


  async function loadModuleSettings(
    moduleName
  ) {

    await initialize();

    requireUserId();


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .MODULE_SETTINGS
        )
        .select("*")
        .eq(
          "module_name",
          moduleName
        );


    if (error) {
      throw error;
    }


    const result = {};


    for (
      const row of
      data || []
    ) {

      result[
        row.setting_key
      ] =
        clone(
          row.value
        );

    }


    return result;

  }


  // ============================================================
  // PERIOD SNAPSHOTS
  // ============================================================

  async function savePeriodSnapshot(
    snapshot
  ) {

    await initialize();


    const userId =
      requireUserId();


    const operation = {

      kind:
        "snapshot",

      moduleName:
        requireText(
          snapshot.moduleName,
          "snapshot.moduleName"
        ),

      periodType:
        requireText(
          snapshot.periodType,
          "snapshot.periodType"
        ),

      periodStart:
        requireText(
          snapshot.periodStart,
          "snapshot.periodStart"
        ),

      periodEnd:
        requireText(
          snapshot.periodEnd,
          "snapshot.periodEnd"
        ),

      snapshotType:
        requireText(
          snapshot.snapshotType,
          "snapshot.snapshotType"
        ),

      reportingCurrency:
        snapshot.reportingCurrency ||
        "NATIVE",

      calculationVersion:
        String(
          snapshot.calculationVersion ||
          "1"
        ),

      row: {

        user_id:
          userId,

        module_name:
          snapshot.moduleName,

        period_type:
          snapshot.periodType,

        period_start:
          snapshot.periodStart,

        period_end:
          snapshot.periodEnd,

        period_label:
          snapshot.periodLabel ||
          null,

        snapshot_type:
          snapshot.snapshotType,

        reporting_currency:
          snapshot.reportingCurrency ||
          "NATIVE",

        timezone:
          snapshot.timezone ||
          Intl.DateTimeFormat()
            .resolvedOptions()
            .timeZone ||
          "UTC",

        calculation_version:
          String(
            snapshot.calculationVersion ||
            "1"
          ),

        schema_version:
          snapshot.schemaVersion ||
          CONFIG.APP_SCHEMA_VERSION,

        source_data_hash:
          snapshot.sourceDataHash ||
          null,

        source_revisions:
          clone(
            snapshot.sourceRevisions ||
            {}
          ),

        metrics:
          clone(
            snapshot.metrics ||
            {}
          ),

        breakdowns:
          clone(
            snapshot.breakdowns ||
            {}
          ),

        comparison:
          clone(
            snapshot.comparison ||
            {}
          ),

        previous_snapshot_id:
          snapshot.previousSnapshotId ||
          null,

        notes:
          clone(
            snapshot.notes ||
            {}
          ),

        writer_app_version:
          CONFIG.APP_VERSION,

        generated_at:
          snapshot.generatedAt ||
          nowISO()

      }

    };


    enqueueOperation(
      operation
    );


    if (
      INTERNAL.online
    ) {
      await flushQueue();
    }


    return true;

  }


  async function loadPeriodSnapshots(
    moduleName,
    options = {}
  ) {

    await initialize();

    requireUserId();


    let query =
      INTERNAL.client
        .from(
          CONFIG.TABLES
            .PERIOD_SNAPSHOTS
        )
        .select("*")
        .eq(
          "module_name",
          moduleName
        );


    if (
      options.periodType
    ) {
      query =
        query.eq(
          "period_type",
          options.periodType
        );
    }


    if (
      options.snapshotType
    ) {
      query =
        query.eq(
          "snapshot_type",
          options.snapshotType
        );
    }


    if (
      options.reportingCurrency
    ) {
      query =
        query.eq(
          "reporting_currency",
          options.reportingCurrency
        );
    }


    query =
      query.order(
        "period_start",
        {
          ascending: false
        }
      );


    if (
      options.limit
    ) {
      query =
        query.limit(
          Number(
            options.limit
          )
        );
    }


    const {
      data,
      error
    } =
      await query;


    if (error) {
      throw error;
    }


    return clone(
      data || []
    );

  }


  // ============================================================
  // SETTINGS/SNAPSHOT QUEUE PROCESSORS
  // ============================================================

  async function processSettingOperation(
    operation
  ) {

    const {
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .MODULE_SETTINGS
        )
        .upsert(
          operation.row,
          {
            onConflict:
              "user_id,module_name,setting_key"
          }
        );


    if (error) {
      throw error;
    }


    return true;

  }


  async function processSnapshotOperation(
    operation
  ) {

    const {
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .PERIOD_SNAPSHOTS
        )
        .upsert(
          operation.row,
          {
            onConflict:
              "user_id,module_name,period_type,period_start,period_end,snapshot_type,reporting_currency,calculation_version"
          }
        );


    if (error) {
      throw error;
    }


    return true;

  }


  // ============================================================
  // QUEUE EXECUTION
  // ============================================================

  async function processOperation(
    operation
  ) {

    switch (
      operation.kind
    ) {

      case "module-state":
        return processModuleStateOperation(
          operation
        );

      case "module-record":
        return processModuleRecordOperation(
          operation
        );

      case "setting":
        return processSettingOperation(
          operation
        );

      case "snapshot":
        return processSnapshotOperation(
          operation
        );

      default:
        throw new Error(
          `Unknown sync operation: ${operation.kind}`
        );

    }

  }


  async function flushQueue() {

    await initialize();


    if (
      !INTERNAL.user?.id
    ) {
      return {
        processed: 0,
        remaining: 0
      };
    }


    if (
      !INTERNAL.online
    ) {
      return {
        processed: 0,
        remaining:
          getQueueLength()
      };
    }


    if (
      INTERNAL.syncing
    ) {

      return {
        processed: 0,
        remaining:
          getQueueLength(),
        alreadySyncing: true
      };

    }


    INTERNAL.syncing =
      true;

    INTERNAL.lastError =
      null;


    emit(
      "sync-start"
    );


    const userId =
      INTERNAL.user.id;


    let queue =
      getQueue(userId);

    let processed =
      0;


    try {

      while (
        queue.length > 0
      ) {

        const operation =
          queue[0];


        try {

          await processOperation(
            operation
          );


          queue.shift();

          processed += 1;


          saveQueue(
            userId,
            queue
          );


          await logSyncEvent({

            moduleName:
              operation.moduleName ||
              null,

            eventType:
              "sync_success",

            status:
              "success"

          });


        } catch (error) {


          if (
            isRevisionConflict(
              error
            )
          ) {

            await recordConflict(
              operation,
              error
            );


            /*
             * Remove the operation from automatic queue.
             *
             * It is now represented in sync_conflicts and
             * must not overwrite the cloud copy silently.
             */

            queue.shift();

            saveQueue(
              userId,
              queue
            );


            await logSyncEvent({

              moduleName:
                operation.moduleName ||
                null,

              eventType:
                "sync_conflict",

              status:
                "conflict",

              details: {
                message:
                  String(
                    error.message ||
                    error
                  )
              }

            });


            continue;

          }


          if (
            isNetworkError(
              error
            )
          ) {

            INTERNAL.online =
              false;

            INTERNAL.lastError =
              error;


            emit(
              "offline",
              {
                error:
                  String(
                    error.message ||
                    error
                  )
              }
            );


            break;

          }


          /*
           * Do not discard non-network failures.
           *
           * Example:
           * - RLS problem
           * - malformed record
           * - database constraint
           *
           * Keep it queued for diagnosis.
           */

          operation.attempts =
            Number(
              operation.attempts ||
              0
            ) + 1;


          operation.lastError =
            String(
              error.message ||
              error
            );


          operation.lastAttemptAt =
            nowISO();


          queue[0] =
            operation;


          saveQueue(
            userId,
            queue
          );


          INTERNAL.lastError =
            error;


          await logSyncEvent({

            moduleName:
              operation.moduleName ||
              null,

            eventType:
              "sync_failed",

            status:
              "error",

            details: {
              message:
                operation.lastError
            }

          });


          emit(
            "sync-error",
            {
              error:
                operation.lastError
            }
          );


          break;

        }

      }


      if (
        processed > 0
      ) {

        INTERNAL.lastSync =
          nowISO();


        safeLocalSet(
          lastSyncKey(userId),
          INTERNAL.lastSync
        );

      }


      return {

        processed,

        remaining:
          queue.length

      };

    } finally {

      INTERNAL.syncing =
        false;


      emit(
        "sync-end",
        {
          processed,
          remaining:
            queue.length
        }
      );

    }

  }


  // ============================================================
  // SCHEMA REGISTRY
  // ============================================================

  async function loadSchemaRegistry() {

    await initialize();

    requireUserId();


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .SCHEMA_REGISTRY
        )
        .select("*")
        .order(
          "scope_name"
        );


    if (error) {
      throw error;
    }


    return clone(
      data || []
    );

  }


  async function checkSchemaCompatibility(
    scopeName
  ) {

    await initialize();

    requireUserId();


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .SCHEMA_REGISTRY
        )
        .select("*")
        .eq(
          "scope_name",
          scopeName
        )
        .maybeSingle();


    if (error) {
      throw error;
    }


    if (!data) {

      return {
        compatible: true,
        registryMissing: true
      };

    }


    const appSchema =
      CONFIG.APP_SCHEMA_VERSION;


    return {

      compatible:
        appSchema >=
          data.minimum_supported_schema_version &&
        appSchema <=
          data.current_schema_version,

      appSchemaVersion:
        appSchema,

      minimumSupported:
        data.minimum_supported_schema_version,

      currentSchemaVersion:
        data.current_schema_version,

      contractVersion:
        data.contract_version,

      row:
        clone(data)

    };

  }


  // ============================================================
  // MODULE PRESENCE
  //
  // Used later by Unified Dashboard:
  //
  // "3/3 user data stores found"
  // ============================================================

  async function getModulePresence(
    moduleNames = [
      CONFIG.MODULES.ETF,
      CONFIG.MODULES.CFD,
      CONFIG.MODULES.CASH_SAVINGS
    ]
  ) {

    await initialize();

    requireUserId();


    const names =
      moduleNames
        .map(cleanText)
        .filter(Boolean);


    if (!names.length) {

      return {
        requested: 0,
        found: 0,
        missing: [],
        modules: []
      };

    }


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .MODULE_STATE
        )
        .select(
          "module_name,revision,updated_at,last_synced_at"
        )
        .in(
          "module_name",
          names
        );


    if (error) {
      throw error;
    }


    const foundNames =
      new Set(
        (data || [])
          .map(
            row =>
              row.module_name
          )
      );


    return {

      requested:
        names.length,

      found:
        foundNames.size,

      missing:
        names.filter(
          name =>
            !foundNames.has(name)
        ),

      modules:
        clone(
          data || []
        )

    };

  }


  // ============================================================
  // CLOUD BACKUP FOUNDATION
  // ============================================================

  async function createCloudBackup({
    backupType = "manual",
    backupScope = "all",
    moduleName = null,
    payload,
    schemaManifest = {},
    note = null
  }) {

    await initialize();


    const userId =
      requireUserId();


    if (!INTERNAL.online) {

      throw new Error(
        "Cloud backup requires an internet connection."
      );

    }


    const {
      data,
      error
    } =
      await INTERNAL.client
        .from(
          CONFIG.TABLES
            .APP_BACKUPS
        )
        .insert({

          user_id:
            userId,

          backup_type:
            backupType,

          backup_scope:
            backupScope,

          module_name:
            moduleName,

          app_schema_version:
            CONFIG.APP_SCHEMA_VERSION,

          schema_manifest:
            clone(
              schemaManifest
            ),

          payload:
            clone(payload),

          note

        })
        .select("*")
        .single();


    if (error) {
      throw error;
    }


    return data;

  }


  // ============================================================
  // RAW LOCAL CACHE ACCESS
  //
  // Used later by adapters and migration.
  // ============================================================

  function getCachedModuleState(
    moduleName
  ) {

    if (
      !INTERNAL.user?.id
    ) {
      return null;
    }


    return clone(
      readModuleCache(
        INTERNAL.user.id,
        moduleName
      )
    );

  }


  function getPendingQueue() {

    if (
      !INTERNAL.user?.id
    ) {
      return [];
    }


    return clone(
      getQueue(
        INTERNAL.user.id
      )
    );

  }


  // ============================================================
  // PUBLIC API
  // ============================================================

  const API = Object.freeze({

    // Lifecycle
    initialize,

    getClient:
      () => INTERNAL.client,

    getStatus,


    // Authentication
    auth: Object.freeze({

      signUp,

      signIn,

      signOut,

      getSession,

      getUser

    }),


    // Profile
    profile: Object.freeze({

      load:
        loadProfile,

      get:
        getProfile

    }),


    // Device
    device: Object.freeze({

      getId:
        getDeviceId,

      getMetadata:
        getDeviceMetadata,

      register:
        registerInstallation

    }),


    // Complete module snapshots
    module: Object.freeze({

      stage:
        stageModuleState,

      save:
        saveModuleState,

      autoSave:
        autoSaveModuleState,

      load:
        loadModuleState,

      getCached:
        getCachedModuleState,

      presence:
        getModulePresence

    }),


    // Record-level cloud storage
    records: Object.freeze({

      stage:
        stageModuleRecord,

      save:
        saveModuleRecord,

      load:
        loadModuleRecords

    }),


    // Module settings
    settings: Object.freeze({

      save:
        saveModuleSetting,

      load:
        loadModuleSettings

    }),


    // Historical analysis
    periods: Object.freeze({

      save:
        savePeriodSnapshot,

      load:
        loadPeriodSnapshots

    }),


    // Schema
    schema: Object.freeze({

      loadRegistry:
        loadSchemaRegistry,

      check:
        checkSchemaCompatibility

    }),


    // Backup
    backup: Object.freeze({

      create:
        createCloudBackup

    }),


    // Synchronisation
    sync: Object.freeze({

      flush:
        flushQueue,

      pending:
        getPendingQueue

    }),


    // Constants for module adapters
    constants: Object.freeze({

      modules:
        CONFIG.MODULES,

      tables:
        CONFIG.TABLES,

      evidenceBucket:
        CONFIG.EVIDENCE_BUCKET,

      appVersion:
        CONFIG.APP_VERSION,

      schemaVersion:
        CONFIG.APP_SCHEMA_VERSION,

      contractVersion:
        CONFIG.CLOUD_CONTRACT_VERSION

    })

  });


  // ============================================================
  // READ-ONLY GLOBAL EXPORT
  // ============================================================

  Object.defineProperty(
    window,
    "AurumCloud",
    {
      value: API,
      writable: false,
      configurable: false
    }
  );


  // ============================================================
  // DO NOT AUTO-INITIALISE HERE
  //
  // The page will initialise AurumCloud only after:
  //
  // 1. Supabase CDN script loads
  // 2. supabase-config.js loads
  // 3. aurum-cloud.js loads
  //
  // This prevents race conditions.
  // ============================================================

})();