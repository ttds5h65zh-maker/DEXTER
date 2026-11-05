// Composition root: builds every service and wires them together.
import fs from 'node:fs';
import { buildConfig, loadEnvFile } from './config.js';
import { openDatabase } from './db.js';
import { EventBus } from './events.js';
import { initSecretKey } from './lib/crypto.js';
import { setLogLevel } from './lib/log.js';
import { createSettingsService } from './services/settings.js';
import { createTaskService } from './services/tasks.js';
import { createMemoryService } from './services/memory.js';
import { createFileService } from './services/files.js';
import { createDocumentService } from './services/documents.js';
import { createProjectService } from './services/projects.js';
import { createNotificationService } from './services/notifications.js';
import { createConversationService } from './services/conversations.js';
import { createApprovalService } from './services/approvals.js';
import { createModelClient } from './assistant/anthropic.js';
import { createAgent } from './assistant/agent.js';
import { createGoogle } from './integrations/google.js';
import { createBrowser } from './integrations/browser.js';
import { createIntegrations } from './integrations/index.js';
import { createToolRegistry } from './tools/index.js';
import { createJobService } from './scheduler/jobs.js';
import { createScheduler } from './scheduler/scheduler.js';
import { createRunners } from './scheduler/runners.js';

export function createApp(overrides = {}) {
  if (!overrides.skipEnvFile) loadEnvFile();
  const config = buildConfig(process.env, overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.filesDir, { recursive: true });
  setLogLevel(config.logLevel);
  initSecretKey(config);

  const app = { config, db: openDatabase(config.dbPath), bus: new EventBus() };
  app.settings = createSettingsService(app);
  app.tasks = createTaskService(app);
  app.memory = createMemoryService(app);
  app.files = createFileService(app);
  app.documents = createDocumentService(app);
  app.projects = createProjectService(app);
  app.notifications = createNotificationService(app);
  app.conversations = createConversationService(app);
  app.approvals = createApprovalService(app);
  app.model = overrides.model || createModelClient(config);
  app.google = createGoogle(app);
  app.browser = createBrowser(app);
  app.integrations = createIntegrations(app);
  app.tools = createToolRegistry(app);
  app.jobs = createJobService(app);
  app.runners = createRunners(app);
  app.agent = createAgent(app);
  app.scheduler = createScheduler(app);

  app.settings.onChange((sections) => {
    if (sections.includes('notifications')) app.jobs.syncDailyBriefing();
  });

  app.startBackground = () => {
    app.agent.recover();
    app.scheduler.start();
  };

  app.shutdown = async () => {
    app.scheduler.stop();
    app.bus.close();
    await app.browser.close();
    app.db.close();
  };
  return app;
}
