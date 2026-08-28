(() => {
  "use strict";

  /*
   * ==========================================================
   * AURUM IMPERIUM INVESTMENT TRACKER
   * Shared Supabase Configuration
   * ==========================================================
   *
   * SAFE FOR BROWSER:
   * - Supabase Project URL
   * - sb_publishable_... key
   *
   * NEVER PLACE HERE:
   * - database password
   * - sb_secret_... key
   * - service_role key
   * - access token
   * - refresh token
   * - user password
   * ==========================================================
   */

  const CONFIG = Object.freeze({

    // --------------------------------------------------------
    // SUPABASE CONNECTION
    // --------------------------------------------------------

    SUPABASE_URL:
      "https://ikdgulwhduhgfssrudls.supabase.co",

    SUPABASE_PUBLISHABLE_KEY:
      "sb_publishable_vOV1oLhP1whL1pzuH8bNyQ_CMKeH917",


    // --------------------------------------------------------
    // APPLICATION IDENTITY
    // --------------------------------------------------------

    APP_ID:
      "aurum-imperium-investment-tracker",

    APP_NAME:
      "Aurum Imperium Investment Tracker",

    APP_VERSION:
      "1.0-supabase-integration",

    CLOUD_CONTRACT_VERSION:
      2,

    APP_SCHEMA_VERSION:
      1,


    // --------------------------------------------------------
    // PRODUCTION FRONTEND
    // --------------------------------------------------------

    SITE_URL:
      "https://mduduzijunior.github.io/investment-tracker/",


    // --------------------------------------------------------
    // SUPABASE STORAGE
    // --------------------------------------------------------

    EVIDENCE_BUCKET:
      "investment-evidence",


    // --------------------------------------------------------
    // OFFICIAL MODULE IDENTIFIERS
    //
    // These names must remain stable even if visible module
    // titles change later.
    // --------------------------------------------------------

    MODULES: Object.freeze({
      UNIFIED: "unified",
      ETF: "etf",
      CFD: "cfd",
      CASH_SAVINGS: "cash_savings"
    }),


    // --------------------------------------------------------
    // CLOUD TABLE CONTRACT
    //
    // Centralised here so future table naming changes do not
    // require hunting through every module.
    // --------------------------------------------------------

    TABLES: Object.freeze({
      PROFILE: "profiles",
      CLIENT_INSTALLATIONS: "client_installations",
      IMPORT_BATCHES: "import_batches",
      MODULE_STATE: "module_state",
      MODULE_RECORDS: "module_records",
      MODULE_SETTINGS: "module_settings",
      PERIOD_SNAPSHOTS: "period_snapshots",
      MARKET_OBSERVATIONS: "market_observations",
      EVIDENCE_FILES: "evidence_files",
      MIGRATION_CLAIMS: "migration_claims",
      SYNC_CURSORS: "sync_cursors",
      SYNC_EVENTS: "sync_events",
      SYNC_CONFLICTS: "sync_conflicts",
      APP_BACKUPS: "app_backups",
      SCHEMA_REGISTRY: "app_schema_registry"
    }),


    // --------------------------------------------------------
    // RPC FUNCTIONS
    // --------------------------------------------------------

    RPC: Object.freeze({
      SAVE_MODULE_STATE:
        "save_module_state_safe",

      SAVE_MODULE_RECORD:
        "save_module_record_safe"
    }),


    // --------------------------------------------------------
    // LOCAL CACHE CONTRACT
    //
    // Prefixing every new cloud-era localStorage key prevents
    // collisions with the current legacy application.
    // --------------------------------------------------------

    LOCAL_PREFIX:
      "aurum_imperium_cloud_v1",

    LOCAL_KEYS: Object.freeze({
      DEVICE_ID:
        "aurum_imperium_cloud_v1_device_id",

      SYNC_QUEUE:
        "aurum_imperium_cloud_v1_sync_queue",

      SYNC_STATUS:
        "aurum_imperium_cloud_v1_sync_status",

      LAST_SYNC:
        "aurum_imperium_cloud_v1_last_sync",

      OFFLINE_CHANGES:
        "aurum_imperium_cloud_v1_offline_changes"
    })

  });


  // ----------------------------------------------------------
  // BASIC CONFIGURATION VALIDATION
  // ----------------------------------------------------------

  function validateConfig() {

    const errors = [];

    if (
      !CONFIG.SUPABASE_URL ||
      CONFIG.SUPABASE_URL.includes("PASTE_")
    ) {
      errors.push(
        "Supabase Project URL has not been configured."
      );
    }

    if (
      !CONFIG.SUPABASE_PUBLISHABLE_KEY ||
      CONFIG.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_")
    ) {
      errors.push(
        "Supabase publishable key has not been configured."
      );
    }

    if (
      CONFIG.SUPABASE_URL &&
      !CONFIG.SUPABASE_URL.startsWith("https://")
    ) {
      errors.push(
        "Supabase Project URL must begin with https://"
      );
    }

    if (
      CONFIG.SUPABASE_PUBLISHABLE_KEY &&
      !CONFIG.SUPABASE_PUBLISHABLE_KEY.includes("PASTE_") &&
      !CONFIG.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")
    ) {
      errors.push(
        "Expected an sb_publishable_ Supabase key."
      );
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }


  // ----------------------------------------------------------
  // READ-ONLY GLOBAL CONFIGURATION
  // ----------------------------------------------------------

  Object.defineProperty(
    window,
    "AURUM_SUPABASE_CONFIG",
    {
      value: CONFIG,
      writable: false,
      configurable: false
    }
  );


  Object.defineProperty(
    window,
    "AURUM_VALIDATE_SUPABASE_CONFIG",
    {
      value: validateConfig,
      writable: false,
      configurable: false
    }
  );

})();