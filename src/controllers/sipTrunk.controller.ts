import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { sipTrunkService } from '../services/sipTrunk.service';
import { phoneSettingsService } from '../services/phoneSettings.service';
import { successResponse } from '../utils/response.util';
import mongoose from 'mongoose';
import PhoneNumber from '../models/PhoneNumber';

export class SipTrunkController {
  /**
   * Setup SIP trunk with Twilio
   * POST /api/v1/phone-settings/setup-sip-trunk
   */
  async setupSipTrunk(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { label, phone_number, twilio_sid, twilio_auth_token } = req.body;

      console.log('[SIP Trunk Controller] ===== SETUP REQUEST RECEIVED =====');
      console.log('[SIP Trunk Controller] Endpoint:', req.method, req.originalUrl);
      console.log('[SIP Trunk Controller] Full URL:', `${req.protocol}://${req.get('host')}${req.originalUrl}`);
      console.log('[SIP Trunk Controller] User ID:', userId);
      console.log('[SIP Trunk Controller] Request body:', {
        label,
        phone_number,
        twilio_sid,
        twilio_auth_token: '***hidden***'
      });

      // Validate required fields
      if (!label || !phone_number || !twilio_sid || !twilio_auth_token) {
        console.error('[SIP Trunk Controller] Missing required fields');
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing required fields: label, phone_number, twilio_sid, twilio_auth_token'
          }
        });
      }

      // Call Python service to setup SIP trunk
      console.log('[SIP Trunk Controller] Calling Python service...');
      const result = await sipTrunkService.setupSipTrunk({
        label,
        phone_number,
        twilio_sid,
        twilio_auth_token
      });

      console.log('[SIP Trunk Controller] ✅ Python service response:');
      console.log(JSON.stringify(result, null, 2));

      // Save all trunk details to user's phone settings
      console.log('[SIP Trunk Controller] Saving to database...');
      const updatedSettings = await phoneSettingsService.update(userId, {
        livekitSipTrunkId: result.livekit_trunk_id,
        twilioTrunkSid: result.twilio_trunk_sid,
        terminationUri: result.termination_uri,
        originationUri: result.origination_uri,
        twilioPhoneNumber: phone_number
      });

      console.log('[SIP Trunk Controller] ✅ Settings saved:', {
        livekitSipTrunkId: updatedSettings.livekitSipTrunkId,
        twilioTrunkSid: updatedSettings.twilioTrunkSid,
        terminationUri: updatedSettings.terminationUri,
        originationUri: updatedSettings.originationUri,
        twilioPhoneNumber: updatedSettings.twilioPhoneNumber
      });

      console.log('[SIP Trunk Controller] Sending response to frontend...');
      res.json(successResponse(result, 'SIP trunk setup successful'));
    } catch (error) {
      next(error);
    }
  }

  // /**
  //  * Create LiveKit SIP trunk
  //  * POST /api/v1/phone-settings/create-livekit-trunk
  //  */
  // async createLivekitTrunk(req: AuthRequest, res: Response, next: NextFunction) {
  //   try {
  //     const userId = req.user!.id;
  //     const { label, phone_number, sip_address, username, password, transport } = req.body;

  //     // Validate required fields
  //     if (!label || !phone_number || !sip_address) {
  //       return res.status(400).json({
  //         success: false,
  //         error: {
  //           code: 'VALIDATION_ERROR',
  //           message: 'Missing required fields: label, phone_number, sip_address'
  //         }
  //       });
  //     }

  //     // Call Python service to create LiveKit trunk
  //     const result = await sipTrunkService.createLivekitTrunk({
  //       label,
  //       phone_number,
  //       sip_address,
  //       username,
  //       password,
  //       transport: transport || 'udp'
  //     });

  //     // Save trunk details to user's phone settings
  //     await phoneSettingsService.update(userId, {
  //       livekitSipTrunkId: result.livekit_trunk_id,
  //       twilioPhoneNumber: phone_number
  //     });

  //     res.json(successResponse(result, 'LiveKit SIP trunk created successfully'));
  //   } catch (error) {
  //     next(error);
  //   }
  // }

  /**
   * Create Generic SIP trunk
   * POST /api/v1/phone-settings/create-generic-sip-trunk
   */
  async createGenericSipTrunk(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { label, phone_number, sip_address, username, password, provider_name, transport, port } = req.body;

      console.log('[SIP Trunk Controller] ===== CREATE GENERIC SIP TRUNK REQUEST =====');
      console.log('[SIP Trunk Controller] Endpoint:', req.method, req.originalUrl);
      console.log('[SIP Trunk Controller] User ID:', userId);
      console.log('[SIP Trunk Controller] Request body:', {
        label,
        phone_number,
        sip_address,
        username,
        password: '***hidden***',
        provider_name: provider_name || 'generic',
        transport: transport || 'udp',
        port: port || 5060
      });

      // Validate required fields
      if (!label || !phone_number || !sip_address || !username || !password) {
        console.error('[SIP Trunk Controller] Missing required fields');
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing required fields: label, phone_number, sip_address, username, password'
          }
        });
      }

      // Call Python service to create Generic SIP trunk
      console.log('[SIP Trunk Controller] Calling Python service...');
      const result = await sipTrunkService.createGenericSipTrunk({
        label,
        phone_number,
        sip_address,
        username,
        password,
        provider_name: provider_name || 'generic',
        transport: transport || 'udp',
        port: port || 5060
      });

      console.log('[SIP Trunk Controller] ✅ Python service response:');
      console.log(JSON.stringify(result, null, 2));

      // Save trunk details to user's phone settings
      console.log('[SIP Trunk Controller] Saving to database...');
      const updatedSettings = await phoneSettingsService.update(userId, {
        livekitSipTrunkId: result.livekit_trunk_id,
        twilioPhoneNumber: phone_number,
        sipAddress: sip_address,
        sipUsername: username,
        providerName: result.provider_name,
        transport: result.transport
      });

      console.log('[SIP Trunk Controller] ✅ Settings saved:', {
        livekitSipTrunkId: updatedSettings.livekitSipTrunkId,
        twilioPhoneNumber: updatedSettings.twilioPhoneNumber,
        sipAddress: updatedSettings.sipAddress,
        providerName: updatedSettings.providerName
      });

      console.log('[SIP Trunk Controller] Sending response to frontend...');
      res.json(successResponse(result, 'Generic SIP trunk created successfully'));
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create Inbound trunk with dispatch rule
   * POST /api/v1/phone-settings/create-inbound-trunk
   */
  async createInboundTrunk(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { name, phone_numbers, allowed_numbers, krisp_enabled } = req.body;

      console.log('[SIP Trunk Controller] ===== CREATE INBOUND TRUNK REQUEST =====');
      console.log('[SIP Trunk Controller] Endpoint:', req.method, req.originalUrl);
      console.log('[SIP Trunk Controller] User ID:', userId);
      console.log('[SIP Trunk Controller] Request body:', {
        name,
        phone_numbers,
        allowed_numbers: allowed_numbers || [],
        krisp_enabled: krisp_enabled !== undefined ? krisp_enabled : true
      });

      // Validate required fields
      if (!name || !phone_numbers || !Array.isArray(phone_numbers) || phone_numbers.length === 0) {
        console.error('[SIP Trunk Controller] Missing or invalid required fields');
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Missing required fields: name, phone_numbers (array with at least one number)'
          }
        });
      }

      // Step 1: Create inbound trunk
      console.log('[SIP Trunk Controller] Step 1: Creating inbound trunk...');
      const trunkResult = await sipTrunkService.createInboundTrunk({
        name,
        phone_numbers,
        allowed_numbers: allowed_numbers || [],
        krisp_enabled: krisp_enabled !== undefined ? krisp_enabled : true
      });

      console.log('[SIP Trunk Controller] ✅ Inbound trunk created:');
      console.log(JSON.stringify(trunkResult, null, 2));

      // Step 2: Create dispatch rule using the trunk_id
      console.log('[SIP Trunk Controller] Step 2: Creating dispatch rule with trunk_id:', trunkResult.trunk_id);
      
      // Generate a unique name for the dispatch rule
      const uniqueName = `dispatch-${Date.now()}`;
      
      const dispatchResult = await sipTrunkService.createDispatchRule({
        sip_trunk_id: trunkResult.trunk_id,
        name: uniqueName,  // Random unique name
        agent_name: 'love-papa'  // Fixed agent name as requested
      });

      console.log('[SIP Trunk Controller] ✅ Dispatch rule created:');
      console.log(JSON.stringify(dispatchResult, null, 2));

      // Combine results
      const combinedResult = {
        trunk: trunkResult,
        dispatch_rule: dispatchResult
      };

      // Save to database
      console.log('[SIP Trunk Controller] Saving to database...');
      const updatedSettings = await phoneSettingsService.update(userId, {
        inboundTrunkId: trunkResult.trunk_id,
        inboundTrunkName: trunkResult.trunk_name,
        inboundPhoneNumbers: phone_numbers,
        inboundDispatchRuleId: dispatchResult.dispatch_rule_id,
        inboundDispatchRuleName: dispatchResult.dispatch_rule_name
      });

      console.log('[SIP Trunk Controller] ✅ Settings saved:', {
        inboundTrunkId: updatedSettings.inboundTrunkId,
        inboundTrunkName: updatedSettings.inboundTrunkName,
        inboundDispatchRuleId: updatedSettings.inboundDispatchRuleId,
        inboundDispatchRuleName: updatedSettings.inboundDispatchRuleName
      });

      console.log('[SIP Trunk Controller] Sending response to frontend...');
      res.json(successResponse(combinedResult, 'Inbound trunk and dispatch rule created successfully'));
    } catch (error) {
      next(error);
    }
  }

  /**
   * Initiate outbound call via SIP trunk
   * POST /api/v1/sip-trunk/outbound-call
   */
  async outboundCall(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        agent_id,
        agent_phone_number_id,
        to_number,
        customer_info,
        dynamic_variables,
        sender_email: requestSenderEmail,
        omit_sender_email
      } = req.body;

      // sender_email is only forwarded when explicitly provided in the request body.
      // Outbound test calls should pass omit_sender_email: true (or omit sender_email entirely).
      const sender_email =
        omit_sender_email || !requestSenderEmail
          ? undefined
          : String(requestSenderEmail).trim() || undefined;

      if (omit_sender_email) {
        console.log('[SIP Trunk Controller] omit_sender_email=true — sender_email excluded from outbound payload');
      }

      console.log('[SIP Trunk Controller] ===== OUTBOUND CALL REQUEST =====');
      console.log('[SIP Trunk Controller] Endpoint:', req.method, req.originalUrl);
      console.log('[SIP Trunk Controller] Request body:', {
        agent_id,
        agent_phone_number_id,
        to_number,
        customer_info,
        dynamic_variables: dynamic_variables ? '[provided]' : undefined,
        omit_sender_email: !!omit_sender_email,
        sender_email: sender_email || 'not provided'
      });

      // Validate required fields
      if (!agent_id || !agent_phone_number_id || !to_number) {
        return res.status(422).json({
          detail: [{
            loc: ["body"],
            msg: "agent_id, agent_phone_number_id, and to_number are required",
            type: "value_error"
          }]
        });
      }

      // Fetch phone number from database to verify it exists and get details
      const PhoneNumber = (await import('../models/PhoneNumber')).default;
      const phoneNumber = await PhoneNumber.findOne({ 
        phone_number_id: agent_phone_number_id 
      });

      if (!phoneNumber) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'PHONE_NUMBER_NOT_FOUND',
            message: `Phone number with id ${agent_phone_number_id} not found in database`
          }
        });
      }

      console.log('[SIP Trunk Controller] Phone number found:', {
        phone_number_id: phoneNumber.phone_number_id,
        phone_number: phoneNumber.phone_number,
        provider: phoneNumber.provider,
        label: phoneNumber.label,
        supports_outbound: phoneNumber.supports_outbound,
        has_outbound_config: !!phoneNumber.outbound_trunk_config
      });

      // Validate phone number supports outbound calls
      if (!phoneNumber.supports_outbound) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PHONE_NUMBER_NOT_OUTBOUND',
            message: `Phone number ${agent_phone_number_id} does not support outbound calls`
          }
        });
      }

      // Route by provider: Twilio uses a different Python API endpoint than SIP trunk
      let result;
      if (phoneNumber.provider === 'twilio') {
        // Twilio outbound: must use ElevenLabs phone_number_id
        // Auto-register if missing (for backward compatibility with existing numbers)
        if (!phoneNumber.elevenlabs_phone_number_id) {
          // Validate required fields for registration
          if (!phoneNumber.sid || !phoneNumber.token) {
            return res.status(400).json({
              success: false,
              error: {
                code: 'MISSING_CREDENTIALS',
                message: `Twilio phone number ${agent_phone_number_id} is missing sid or token. Cannot register with ElevenLabs.`
              }
            });
          }

          console.log('[SIP Trunk Controller] Twilio number not registered, attempting auto-registration with ElevenLabs...');
          try {
            const elevenLabsResponse = await sipTrunkService.registerTwilioPhoneNumberWithElevenLabs({
              label: phoneNumber.label,
              phone_number: phoneNumber.phone_number,
              sid: phoneNumber.sid,
              token: phoneNumber.token,
              supports_inbound: phoneNumber.supports_inbound || false,
              supports_outbound: phoneNumber.supports_outbound || false
            });

            // Update phone number with ElevenLabs ID
            await PhoneNumber.updateOne(
              { phone_number_id: agent_phone_number_id },
              { $set: { elevenlabs_phone_number_id: elevenLabsResponse.phone_number_id } }
            );

            phoneNumber.elevenlabs_phone_number_id = elevenLabsResponse.phone_number_id;
            console.log('[SIP Trunk Controller] ✅ Twilio number auto-registered with ElevenLabs:', elevenLabsResponse.phone_number_id);
          } catch (registerError: any) {
            // Registration failed - log full error details
            console.error('[SIP Trunk Controller] ❌ Auto-registration failed:', registerError.message);
            console.error('[SIP Trunk Controller] ❌ Error status:', registerError.statusCode);
            console.error('[SIP Trunk Controller] ❌ Error code:', registerError.code);
            console.error('[SIP Trunk Controller] ❌ Error response:', JSON.stringify(registerError.response?.data || {}, null, 2));
            
            // Don't fall back to phone number - registration is required
            return res.status(registerError.statusCode || 500).json({
              success: false,
              error: {
                code: registerError.code || 'REGISTRATION_ERROR',
                message: `Failed to register Twilio phone number with ElevenLabs: ${registerError.message}. Please try registering manually via POST /api/v1/phone-numbers/${agent_phone_number_id}/register`
              }
            });
          }
        }
        console.log('[SIP Trunk Controller] Using Twilio outbound endpoint; agent_phone_number_id:', phoneNumber.elevenlabs_phone_number_id, 'from_number:', phoneNumber.phone_number);
        result = await sipTrunkService.twilioOutboundCall({
          agent_id,
          agent_phone_number_id: phoneNumber.elevenlabs_phone_number_id,
          to_number,
          customer_info,
          dynamic_variables,
          sender_email,
          // Include credentials if using phone number as ID (not a registered ElevenLabs ID)
          ...(phoneNumber.elevenlabs_phone_number_id?.startsWith('+') && {
            phone_number: phoneNumber.phone_number,
            sid: phoneNumber.sid,
            token: phoneNumber.token
          })
        });
      } else {
        // SIP trunk: must use ElevenLabs phone_number_id
        if (!phoneNumber.elevenlabs_phone_number_id) {
          return res.status(400).json({
            success: false,
            error: {
              code: 'PHONE_NUMBER_NOT_REGISTERED',
              message: `Phone number ${agent_phone_number_id} is not registered with ElevenLabs. Please register it first via POST /api/v1/phone-numbers/${agent_phone_number_id}/register`
            }
          });
        }
        console.log('[SIP Trunk Controller] Using SIP trunk endpoint with ElevenLabs phone_number_id:', phoneNumber.elevenlabs_phone_number_id);
        result = await sipTrunkService.outboundCall({
          agent_id,
          agent_phone_number_id: phoneNumber.elevenlabs_phone_number_id,
          to_number,
          customer_info,
          dynamic_variables,
          sender_email
        });
      }

      console.log('[SIP Trunk Controller] ✅ Outbound call initiated:');
      console.log(JSON.stringify(result, null, 2));

      // Create conversation for the outbound call so it appears in conversations tab
      if (result.success && result.conversation_id) {
        try {
          const Conversation = (await import('../models/Conversation')).default;
          const Customer = (await import('../models/Customer')).default;
          const Message = (await import('../models/Message')).default;
          const organizationId = req.user?.organizationId || req.user?._id;
          
          if (!organizationId) {
            console.warn('[SIP Trunk Controller] ⚠️ No organizationId found, skipping conversation creation');
          } else {
            // Find or create customer
            const customerPhone = to_number;
            const customerName = customer_info?.name || 'Unknown';
            const customerEmail = customer_info?.email;
            
            let customer = await Customer.findOne({
              phone: customerPhone,
              organizationId: organizationId instanceof mongoose.Types.ObjectId 
                ? organizationId 
                : new mongoose.Types.ObjectId(organizationId.toString())
            });
            
            if (!customer) {
              customer = await Customer.create({
                organizationId: organizationId instanceof mongoose.Types.ObjectId 
                  ? organizationId 
                  : new mongoose.Types.ObjectId(organizationId.toString()),
                name: customerName,
                phone: customerPhone,
                ...(customerEmail && { email: customerEmail }),
                source: 'phone'
              });
              console.log('[SIP Trunk Controller] ✅ Created customer:', customer._id);
            } else {
              // Update customer info if provided
              if (customerName !== 'Unknown' && customer.name !== customerName) {
                customer.name = customerName;
              }
              if (customerEmail && customer.email !== customerEmail) {
                customer.email = customerEmail;
              }
              await customer.save();
            }

            // Create conversation
            const conversation = await Conversation.create({
              organizationId: organizationId instanceof mongoose.Types.ObjectId 
                ? organizationId 
                : new mongoose.Types.ObjectId(organizationId.toString()),
              customerId: customer._id,
              channel: 'phone',
              status: 'open',
              isAiManaging: true,
              unread: true,
              metadata: {
                conversation_id: result.conversation_id, // Store Python API conversation_id - used to fetch transcript/recording
                callerId: result.conversation_id, // Also store as callerId for transcript polling compatibility
                callSid: (result as any).callSid || result.sip_call_id,
                phone_number_id: agent_phone_number_id,
                from_number: phoneNumber.phone_number,
                to_number: to_number,
                callInitiated: new Date(),
                provider: phoneNumber.provider
              }
            });

            // Add initial message indicating outbound call was initiated
            await Message.create({
              conversationId: conversation._id,
              type: 'internal_note',
              text: `Outbound call initiated to ${customerName} (${customerPhone})`,
              sender: 'ai',
              timestamp: new Date()
            });

            console.log('[SIP Trunk Controller] ✅ Created conversation:', conversation._id);
            console.log('[SIP Trunk Controller] Conversation will appear in conversations tab');
            
            // Add conversation ID to response so frontend can navigate to it
            (result as any).conversation_db_id = conversation._id.toString();
          }
        } catch (convError: any) {
          // Don't fail the call if conversation creation fails - log and continue
          console.error('[SIP Trunk Controller] ❌ Failed to create conversation:', convError.message);
          console.error('[SIP Trunk Controller] Error stack:', convError.stack);
        }
      }

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
}

export const sipTrunkController = new SipTrunkController();

