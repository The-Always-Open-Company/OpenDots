// CopilotKit reads this when its telemetry singletons are created at import
// time, so this module must be imported before anything that loads CopilotKit.
// OpenDots runs on-premises and does not report usage.
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
