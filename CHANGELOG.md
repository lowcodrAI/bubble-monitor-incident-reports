# CHANGELOG

All notable changes, incidents, and fixes for the Bubble Monitor system will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.1.1] - 2025-06-30

### 🐛 Fixed
- **CRITICAL**: Fixed log samples not being created since June 20, 2025
  - **Issue**: Invalid `session_id` field in edge function causing PostgreSQL INSERT failures
  - **Root Cause**: Referenced non-existent column in `monitor_log_samples` table
  - **Solution**: Store `session_id` in `metadata` JSON field instead of separate column
  - **Impact**: Restored sample creation, breadcrumb storage, and error context collection

### 🔧 Changed
- **Edge Function (ingest)**: Removed invalid `session_id` field from sample data object
- **Error Handling**: Enhanced logging for sample insertion failures and successes
- **Data Storage**: Session IDs now properly stored in `metadata.session_id` field

### 📊 Impact
- **Downtime**: 10 days (June 20-30, 2025)
- **Recovery**: Immediate - samples now being created successfully
- **Data**: ~1,000+ missing samples during outage period

### 🔍 Technical Details
```diff
// Before (causing failures)
const sampleData = {
  group_id,
  user_id,
- session_id: effectiveSessionId, // Column doesn't exist!
  metadata: metadata || {},
  // ...
};

// After (fixed)
const sampleData = {
  group_id,
  user_id,
  metadata: {
    ...(metadata || {}),
+   session_id: effectiveSessionId // Store in metadata JSON
  },
  // ...
};
```

## [4.1.0] - 2025-06-20

### ⚠️ Breaking Issue Introduced
- **Bug Introduced**: Added invalid `session_id` field to sample data object
- **Impact**: Log samples, breadcrumbs, and error context stopped being created
- **Duration**: June 20-30, 2025 (10 days)
- **Root Cause**: Database schema mismatch - column doesn't exist

---

## Legend

- 🐛 **Fixed** - Bug fixes
- ✨ **Added** - New features
- 🔧 **Changed** - Changes in existing functionality
- 🗑️ **Removed** - Removed features
- 📊 **Impact** - System impact analysis
- ⚠️ **Breaking** - Breaking changes or critical issues
- 🔒 **Security** - Security fixes
