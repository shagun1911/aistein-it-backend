// Load environment variables FIRST before any other imports
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { createServer as createTcpServer } from 'net';
import cors from 'cors';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { connectDatabase } from './config/database';
import { connectRedis } from './config/redis';
import { initializeSocket } from './config/socket';
import { errorHandler } from './middleware/error.middleware';
import { logger } from './utils/logger.util';
import passport from './config/passport';
import authRoutes from './routes/auth.routes';
import conversationRoutes from './routes/conversation.routes';
import folderRoutes from './routes/folder.routes';
import labelRoutes from './routes/label.routes';
import templateRoutes from './routes/template.routes';
import knowledgeBaseRoutes from './routes/knowledgeBase.routes';
import promptRoutes from './routes/prompt.routes';
import aiBehaviorRoutes from './routes/aiBehavior.routes';
import agentRoutes from './routes/agent.routes';
import emailTemplateRoutes from './routes/emailTemplate.routes';
import chatbotRoutes from './routes/chatbot.routes';
import contactRoutes from './routes/contact.routes';
import campaignRoutes from './routes/campaign.routes';
import automationRoutes from './routes/automation.routes';
import webhookRoutes from './routes/webhook.routes';
import analyticsRoutes from './routes/analytics.routes';
import phoneSettingsRoutes from './routes/phoneSettings.routes';
import toolRoutes from './routes/tool.routes';
import settingsRoutes from './routes/settings.routes';
import apiKeysRoutes from './routes/apiKeys.routes';
import googleIntegrationRoutes from './routes/googleIntegration.routes';
import socialIntegrationRoutes from './routes/socialIntegration.routes';
import metaRoutes from './routes/meta.routes';
import dialog360WebhookRoutes from './routes/webhook.routes';
import profileRoutes from './routes/profile.routes';
import inboundAgentConfigRoutes from './routes/inboundAgentConfig.routes';
import outboundAgentConfigRoutes from './routes/outboundAgentConfig.routes';
import inboundNumbersRoutes from './routes/inboundNumbers.routes'; // Uses new InboundNumber model
import whatsappRoutes from './routes/whatsapp.routes';
import phoneNumberRoutes from './routes/phoneNumber.routes';
import sipTrunkRoutes from './routes/sipTrunk.routes';
import batchCallingRoutes from './routes/batchCalling.routes';
import emailWebhookRoutes from './routes/emailWebhook.routes';
import elevenlabsWebhookRoutes from './routes/elevenlabsWebhook.routes';
// import toolWebhookRoutes from './routes/toolWebhook.routes'; // DISABLED - calendar only in automations

import instagramWebhookRoutes from './routes/instagramWebhook.routes';
import adminRoutes from './routes/admin.routes';
import planRoutes from './routes/plan.routes';
import planWarningsRoutes from './routes/planWarnings.routes';
import ttsRoutes from './routes/tts.routes';
import paymentRoutes from './routes/payment.routes';


const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
initializeSocket(httpServer);

// ============================================================================
// STEP 1: GLOBAL REQUEST LOGGING (optional, dev-only to reduce noise)
// Set LOG_REQUESTS=1 to log every request; otherwise one line in development only
// ============================================================================
const logRequests = process.env.LOG_REQUESTS === '1';
const isDev = process.env.NODE_ENV !== 'production';
app.use((req, res, next) => {
  if (logRequests) {
    console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  } else if (isDev && (req.method !== 'OPTIONS' && req.path !== '/health')) {
    console.log(`[REQ] ${req.method} ${req.path}`);
  }
  next();
});

// Middleware
// CORS configuration - allows all origins for embedded SaaS widget
// This enables the chatbot widget to be embedded on any third-party domain
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (Postman, curl, server-to-server)
    if (!origin) return callback(null, true);

    // Allow all origins for embedded widget (SaaS requirement)
    // This enables the widget to work on any domain where it's embedded
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  credentials: false // Set to false for cross-origin requests from any domain
}));

// Explicit preflight handling for all routes
app.options('*', cors());

// ============================================================================
// CRITICAL: WooCommerce Webhook Route (MUST be before express.json())
// ============================================================================
// WooCommerce webhook requires raw request body for signature verification.
// This route MUST be defined BEFORE express.json() so the raw body is available.
// If express.json() runs first, it will parse the body and signature verification will fail.
import woocommerceWebhookController from './controllers/woocommerceWebhook.controller';
app.post(
  '/webhooks/woocommerce',
  express.raw({ type: 'application/json' }),
  woocommerceWebhookController.handleWebhook.bind(woocommerceWebhookController)
);

// Body parsers - but note: multer will handle multipart/form-data
// All other routes will use JSON parsing normally
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Initialize Passport
app.use(passport.initialize());

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Root endpoint with API information
app.get('/', (req, res) => {
  res.json({
    name: 'AI Chatbot Management Platform API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/v1/health',
      auth: '/api/v1/auth',
      conversations: '/api/v1/conversations',
      contacts: '/api/v1/contacts',
      campaigns: '/api/v1/campaigns',
      automations: '/api/v1/automations',
      analytics: '/api/v1/analytics',
      settings: '/api/v1/settings',
      knowledgeBase: '/api/v1/training/knowledge-bases',
      knowledgeBasesAlias: '/api/v1/knowledge-bases',
      prompts: '/api/v1/training/prompts',
      aiBehavior: '/api/v1/ai-behavior',
      chatbot: '/api/v1/chatbot',
      webhooks: '/api/v1/webhooks',
      phoneSettings: '/api/v1/phone-settings',
      tools: '/api/v1/tools',
      apiKeys: '/api/v1/api-keys',
      profile: '/api/v1/profile'
    },
    documentation: 'Swagger UI not yet implemented - use Postman collection',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// STEP 6: ENHANCED HEALTH ENDPOINT
// Returns PID, PORT, uptime, environment for frontend verification
// ============================================================================
// Lightweight warmup endpoint — no DB, no module imports, no work.
// The signin page pings this on mount so the server (and any sleeping
// host like Render free tier) is awake by the time the user clicks Login.
// Keeping this dependency-free is critical: /api/v1/health does dynamic
// imports that themselves cost seconds on cold start.
app.get('/api/v1/warmup', (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    uptimeSec: Math.floor((Date.now() - SERVER_START_TIME) / 1000)
  });
});

app.get('/api/v1/health', async (req, res) => {
  try {
    // Get batch call queue status
    const { isBatchCallQueueAvailable } = await import('./queues/batchCall.queue');
    const batchCallQueueAvailable = isBatchCallQueueAvailable();
    
    const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    
    res.json({ 
      status: 'ok', 
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      server: {
        pid: SERVER_PID,
        port: PORT_NUMBER,
        uptime: uptimeSeconds,
        uptimeFormatted: `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
        environment: process.env.NODE_ENV || 'development',
        gitCommit: GIT_COMMIT_HASH || null
      },
      batchCallCompletion: {
        mode: 'webhook',
        note: 'post_call_transcription webhooks; manual POST /batch-calling/:jobId/sync'
      },
      batchCallQueue: {
        enabled: batchCallQueueAvailable,
        status: batchCallQueueAvailable ? 'active' : 'unavailable (using synchronous processing)'
      }
    });
  } catch (error) {
    const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    
    res.json({ 
      status: 'ok', 
      message: 'Server is running',
      timestamp: new Date().toISOString(),
      server: {
        pid: SERVER_PID,
        port: PORT_NUMBER,
        uptime: uptimeSeconds,
        uptimeFormatted: `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
        environment: process.env.NODE_ENV || 'development',
        gitCommit: GIT_COMMIT_HASH || null
      }
    });
  }
});

// Meta Public Routes (no authentication required)
// These routes are required by Meta for compliance (e.g., User Data Deletion)
app.use('/meta', metaRoutes);

// API Routes
app.use('/api/v1/auth', authRoutes);
// Note: Folder and label routes MUST come before conversations route to avoid routing conflicts
app.use('/api/v1/conversations/folders', folderRoutes);
app.use('/api/v1/conversations/labels', labelRoutes);
app.use('/api/v1/conversations', conversationRoutes);
app.use('/api/v1/settings/templates', templateRoutes);
app.use('/api/v1/settings', settingsRoutes); // General settings
app.use('/api/v1/training/knowledge-bases', knowledgeBaseRoutes);
app.use('/api/v1/knowledge-bases', knowledgeBaseRoutes);
app.use('/api/v1/knowledge-base', knowledgeBaseRoutes);
app.use('/api/v1/training/knowledge-base', knowledgeBaseRoutes);
app.use('/api/v1/training/prompts', promptRoutes);
app.use('/api/v1/ai-behavior', aiBehaviorRoutes);
app.use('/api/v1/agents', agentRoutes);
app.use('/api/v1/email-templates', emailTemplateRoutes);
app.use('/api/v1/chatbot', chatbotRoutes);
app.use('/api/v1/contacts', contactRoutes);
app.use('/api/v1/campaigns', campaignRoutes);
app.use('/api/v1/automations', automationRoutes);
app.use('/api/v1/webhooks', webhookRoutes);
app.use('/api/v1/webhooks/instagram', instagramWebhookRoutes); // Instagram webhook (separate from OAuth)
// Note: WooCommerce webhook is defined above BEFORE express.json() to receive raw body
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/phone-settings', phoneSettingsRoutes);
app.use('/api/v1/tools', toolRoutes);
app.use('/api/v1/api-keys', apiKeysRoutes);
app.use('/api/v1/integrations', googleIntegrationRoutes);
app.use('/api/v1/social-integrations', socialIntegrationRoutes);
app.use('/api/v1/webhooks/360dialog', dialog360WebhookRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/inbound-agent-config', inboundAgentConfigRoutes);
app.use('/api/v1/outbound-agent-config', outboundAgentConfigRoutes);
app.use('/api/v1/inbound-numbers', inboundNumbersRoutes);
app.use('/api/v1/phone-numbers', phoneNumberRoutes);
app.use('/api/v1/sip-trunk', sipTrunkRoutes);
app.use('/api/v1/batch-calling', batchCallingRoutes);
app.use('/api/v1/webhook', emailWebhookRoutes); // Email webhook for Python API (agent email tool)
app.use('/', elevenlabsWebhookRoutes); // ElevenLabs webhook for call events
// DISABLED: Calendar booking only through automations, not during live calls
// app.use('/api/v1/tools/webhook', toolWebhookRoutes); // Tool webhooks for ElevenLabs voice agents
app.use('/api/v1/whatsapp', whatsappRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/plans', planRoutes);
app.use('/api/v1/plan-warnings', planWarningsRoutes);
app.use('/api/v1/tts', ttsRoutes);
app.use('/api/payment', paymentRoutes); // Payment status endpoint (read-only)

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found'
    }
  });
});

// Error Handler (must be last)
app.use(errorHandler);

// ============================================================================
// STEP 2: SINGLE SOURCE OF TRUTH FOR PORT (FIX)
// Enforce PORT from environment ONLY - crash if undefined
// ============================================================================
const PORT = process.env.PORT;

if (!PORT) {
  console.error('❌ [FATAL] PORT environment variable is REQUIRED');
  console.error('❌ [FATAL] Set PORT in .env file or environment');
  console.error('❌ [FATAL] Example: PORT=5001');
  process.exit(1);
}

const PORT_NUMBER = parseInt(PORT, 10);
if (isNaN(PORT_NUMBER) || PORT_NUMBER < 1 || PORT_NUMBER > 65535) {
  console.error('❌ [FATAL] PORT must be a valid number between 1 and 65535');
  console.error('❌ [FATAL] Current value:', PORT);
  process.exit(1);
}

// ============================================================================
// STEP 4: PORT-IN-USE DETECTION
// Check if port is already in use before starting
// ============================================================================
const checkPortInUse = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = createTcpServer();
    server.listen(port, () => {
      server.once('close', () => resolve(false));
      server.close();
    });
    server.on('error', () => resolve(true));
  });
};

// ============================================================================
// STEP 5: GET GIT COMMIT HASH (if available)
// ============================================================================
function getGitCommitHash(): string | null {
  try {
    // Check if .git directory exists
    const gitDir = join(process.cwd(), '.git');
    if (!existsSync(gitDir)) {
      return null;
    }
    // Get current commit hash
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    return hash || null;
  } catch (error) {
    return null;
  }
}

const GIT_COMMIT_HASH = getGitCommitHash();
const SERVER_PID = process.pid;
const SERVER_START_TIME = Date.now();

const startServer = async () => {
  try {
    // ============================================================================
    // STEP 4: PORT-IN-USE DETECTION (before any other operations)
    // ============================================================================
    const portInUse = await checkPortInUse(PORT_NUMBER);
    if (portInUse) {
      console.error('❌ [FATAL] Port', PORT_NUMBER, 'is already in use');
      console.error('❌ [FATAL] Another backend instance may be running');
      console.error('❌ [FATAL] Kill the existing process or use a different PORT');
      process.exit(1);
    }

    // ============================================================================
    // STEP 5: STARTUP BANNER (permanent, always visible)
    // ============================================================================
    console.log('\n' + '='.repeat(80));
    console.log('🚀 BACKEND SERVER STARTING');
    console.log('='.repeat(80));
    console.log('📋 Process ID (PID):', SERVER_PID);
    console.log('🔌 Port:', PORT_NUMBER);
    console.log('🌍 Environment:', process.env.NODE_ENV || 'development');
    if (GIT_COMMIT_HASH) {
      console.log('📦 Git Commit:', GIT_COMMIT_HASH);
    } else {
      console.log('📦 Git Commit: (not available)');
    }
    console.log('⏰ Start Time:', new Date().toISOString());
    console.log('='.repeat(80) + '\n');

    // Log configuration on startup
    console.log('🔧 Server Configuration:');
    console.log('   - Environment:', process.env.NODE_ENV || 'development');
    console.log('   - Port:', PORT_NUMBER);
    console.log('   - CORS: All origins allowed (embedded widget support)');
    console.log('   - MongoDB:', process.env.MONGODB_URI ? '✓ Configured' : '✗ Missing');
    console.log('   - Redis:', process.env.REDIS_URL ? '✓ Configured' : '✗ Missing');
    console.log('');

    // Connect to MongoDB
    await connectDatabase();
    
    // Normalize all existing agent template variables to lowercase (one-time migration)
    try {
      const { normalizeAllAgentTemplates } = await import('./utils/migrateAgentTemplateVariables');
      await normalizeAllAgentTemplates();
    } catch (error: any) {
      logger.warn('⚠️  Could not normalize agent templates:', error.message);
      // Don't block server startup if migration fails
    }
    
    // Connect to Redis
    await connectRedis();

    // Initialize default plans if none exist
    try {
      const { planService } = await import('./services/plan.service');
      await planService.initializeDefaultPlans();
      logger.info('✅ Plans initialized');
    } catch (error: any) {
      logger.warn('⚠️  Could not initialize plans:', error.message);
    }

    // Initialize CSV import queue (will check Redis availability internally)
    try {
      await import('./queues/csvImport.queue');
      // Queue creation happens asynchronously after Redis connection
      logger.info('✅ CSV Import queue module loaded');
    } catch (error: any) {
      logger.warn('⚠️  Could not load CSV import queue:', error.message);
    }

    // Initialize Batch Call queue (for background processing of large batch calls)
    try {
      await import('./queues/batchCall.queue');
      // Queue creation happens asynchronously after Redis connection
      logger.info('✅ Batch Call queue module loaded');
    } catch (error: any) {
      logger.warn('⚠️  Could not load Batch Call queue:', error.message);
    }

    // Resync all agents with tool_ids to ElevenLabs on startup
    // This ensures tools survive server restarts and are always available
    try {
      const { agentService } = await import('./services/agent.service');
      const Agent = (await import('./models/Agent')).default;
      
      const allAgents = await Agent.find({ 
        tool_ids: { $exists: true }
      }).lean();
      
      const agentsWithTools = allAgents.filter((agent: any) => 
        agent.tool_ids && Array.isArray(agent.tool_ids) && agent.tool_ids.length > 0
      );
      
      if (agentsWithTools.length > 0) {
        logger.info(`[ElevenLabs Sync] Resyncing ${agentsWithTools.length} agents with tools on startup...`);

        const results = await Promise.all(
          agentsWithTools.map((agent: any) =>
            agentService.syncAgentToolsToElevenLabs(agent, { quiet: true })
          )
        );
        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.length - succeeded;
        if (failed > 0) {
          logger.info(
            `[ElevenLabs Sync] Startup resync done: ${succeeded} succeeded, ${failed} failed (stale or removed agents are normal)`
          );
        } else {
          logger.info(`[ElevenLabs Sync] ✅ Startup resync completed for ${succeeded} agents`);
        }
      } else {
        logger.info('[ElevenLabs Sync] No agents with tools found, skipping startup resync');
      }
    } catch (error: any) {
      logger.warn('⚠️  Could not perform startup agent sync:', error.message);
      // Don't block server startup if sync fails
    }
    
    // Start server with Socket.io
    httpServer.listen(PORT_NUMBER, () => {
      console.log('\n' + '='.repeat(80));
      console.log('✅ BACKEND SERVER RUNNING');
      console.log('='.repeat(80));
      console.log('📋 PID:', SERVER_PID);
      console.log('🔌 Port:', PORT_NUMBER);
      console.log('🌐 URL: http://localhost:' + PORT_NUMBER);
      console.log('🌍 Environment:', process.env.NODE_ENV || 'development');
      if (GIT_COMMIT_HASH) {
        console.log('📦 Git Commit:', GIT_COMMIT_HASH);
      }
      console.log('='.repeat(80) + '\n');
      
      logger.info(`Server running on port ${PORT_NUMBER} (PID: ${SERVER_PID})`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`Socket.io enabled for real-time messaging`);

      import('./services/metaLeadsPolling.service')
        .then(({ startMetaLeadsPollingScheduler }) => startMetaLeadsPollingScheduler())
        .catch((err) => console.error('[Meta Leads Poll] Failed to start scheduler:', err));
      
      // Log webhook endpoints
      const ngrokBaseUrl = process.env.NGROK_BASE_URL;
      const basePath = ngrokBaseUrl ? ngrokBaseUrl : `http://localhost:${PORT_NUMBER}`;
      
      console.log('📡 Meta Webhooks active:');
      console.log(`   - WhatsApp: ${basePath}/api/v1/social-integrations/whatsapp/webhook`);
      console.log(`   - Messenger: ${basePath}/api/v1/social-integrations/messenger/webhook`);
      console.log(`   - Instagram: ${basePath}/api/v1/social-integrations/instagram/webhook`);
      console.log(`   - Meta Leads webhook: ${basePath}/api/v1/social-integrations/meta-leads/webhook`);
      console.log(`   - Meta Leads OAuth callback: ${basePath}/api/v1/social-integrations/meta-leads/oauth/callback`);
      if (process.env.META_LEADS_POLL_FALLBACK_ENABLED === 'true' || process.env.META_LEADS_POLL_ENABLED === 'true') {
        console.log(`   - Meta Leads (fallback poll): POST ${basePath}/api/v1/social-integrations/meta-leads/poll`);
      }
      
      console.log('\n📡 ElevenLabs Webhook active:');
      console.log(`   - Endpoint: ${basePath}/api/v1/webhook/elevenlabs`);
      console.log(`   - Configure this URL in ElevenLabs webhook settings`);
      
      console.log('\n📡 Custom WhatsApp Webhook active:');
      console.log(`   - Endpoint: ${basePath}/api/v1/webhooks/whatsapp`);
      console.log(`   - Accepts: phone_number, whatsapp_message, response (optional), organization_id (optional)`);
      
      if (ngrokBaseUrl) {
        console.log(`\n🔗 Using ngrok base URL: ${ngrokBaseUrl}`);
        console.log(`   ElevenLabs Webhook URL: ${ngrokBaseUrl}/api/v1/webhook/elevenlabs`);
        console.log(`   Custom WhatsApp Webhook URL: ${ngrokBaseUrl}/api/v1/webhooks/whatsapp`);
      } else {
        console.log(`\n⚠️  NGROK_BASE_URL not set - using localhost`);
        console.log(`   For webhooks, set NGROK_BASE_URL=https://your-ngrok-url.ngrok.io`);
        console.log(`   Custom WhatsApp Webhook URL: http://localhost:${PORT_NUMBER}/api/v1/webhooks/whatsapp`);
      }

    });

    // ============================================================================
    // STEP 4: PORT-IN-USE ERROR HANDLING
    // Handle EADDRINUSE error if port becomes in use after check
    // ============================================================================
    httpServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error('❌ [FATAL] Port', PORT_NUMBER, 'is already in use');
        console.error('❌ [FATAL] Another backend instance may have started');
        console.error('❌ [FATAL] Kill the existing process or use a different PORT');
        process.exit(1);
      } else {
        console.error('❌ [FATAL] Server error:', error);
        process.exit(1);
      }
    });
  } catch (error: any) {
    logger.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message || String(reason);
  logger.error('Unhandled Rejection:', msg);

  // Redis connection errors are transient – don't crash the server.
  // The app has fallbacks (BatchCallMonitor, sync imports) for when Redis is down.
  const isRedisError = msg.includes('max number of clients reached')
    || msg.includes('ECONNREFUSED')
    || msg.includes('ECONNRESET')
    || msg.includes('Redis');
  if (isRedisError) {
    console.error('[Server] ⚠️ Redis error (non-fatal, continuing):', msg);
    return;
  }

  // For truly unexpected errors in production, log but don't crash either —
  // Render will restart the service if it becomes unhealthy via health checks.
  console.error('[Server] ❌ Unhandled Rejection (non-Redis):', msg);
});

startServer();

