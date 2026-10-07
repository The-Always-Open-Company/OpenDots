// CopilotKit and mem0 read these when their telemetry singletons are created at
// import time, so this module must be imported before anything that loads them.
// OpenDots runs on-premises and does not report usage.
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
process.env.MEM0_TELEMETRY = 'false';
