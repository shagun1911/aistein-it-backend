import passport from 'passport';
import { Strategy as GoogleStrategy, Profile as GoogleProfile } from 'passport-google-oauth20';
import User, { IUser } from '../models/User';
import Organization from '../models/Organization';
import { emailService } from '../services/email.service';

// Configure Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback',
      scope: ['profile', 'email']
    },
    async (accessToken: string, refreshToken: string, profile: GoogleProfile, done: any) => {
      try {
        // Check if user already exists
        let user = await User.findOne({ 
          $or: [
            { googleId: profile.id },
            { email: profile.emails?.[0]?.value }
          ]
        });

        if (user) {
          // Update existing user with Google ID if not set
          if (!user.googleId) {
            user.googleId = profile.id;
            user.provider = 'google';
            user.providerId = profile.id;
            await user.save();
          }
          return done(null, user);
        }

        // Create new user (auto-registration)
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('No email found in Google profile'), null);
        }

        const names = profile.displayName?.split(' ') || ['User', ''];
        const firstName = profile.name?.givenName || names[0] || 'User';
        const lastName = profile.name?.familyName || names.slice(1).join(' ') || 'User';

        // Create organization for new user
        const orgName = `${firstName}'s Organization`;
        const orgSlug = `${firstName.toLowerCase()}-${Date.now()}`;
        
        // Create organization first (we'll set ownerId after user is created)
        const mongoose = require('mongoose');
        const tempId = new mongoose.Types.ObjectId();
        
        const organization = await Organization.create({
          name: orgName,
          slug: orgSlug,
          status: 'active',
          plan: 'free',
          ownerId: tempId // Temporary, will update
        });

        // Determine user role - only admin emails get admin role, all others are operators
        const adminEmails = process.env.ADMIN_EMAILS?.split(',').map((e: string) => e.trim().toLowerCase()) || [];
        const isAdminEmail = adminEmails.includes(email.toLowerCase());
        const userRole = isAdminEmail ? 'admin' : 'operator';

        // Create user with organization
        user = await User.create({
          email,
          firstName,
          lastName,
          avatar: profile.photos?.[0]?.value || undefined,
          provider: 'google',
          providerId: profile.id,
          googleId: profile.id,
          organizationId: organization._id as any,
          status: 'active',
          role: userRole, // Only admin emails get admin role, all others are operators
          permissions: isAdminEmail ? ['all'] : []
        });

        // Update organization owner
        organization.ownerId = user._id as any;
        await organization.save();

        void emailService.sendAdminNewUserNotification(user, {
          signupMethod: 'google',
          organizationName: organization.name,
          organizationSlug: organization.slug,
          organizationPlan: organization.plan
        });

        return done(null, user);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

// Serialize user for session
passport.serializeUser((user: any, done) => {
  done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

export default passport;

