/* ============================================================
   FIREBASE AUTHENTICATION MIDDLEWARE

   Shared authentication middleware for DataExtract AI.

   Used to protect backend routes and verify Firebase users.
============================================================ */

const { getAuth } = require("firebase-admin/auth");

async function requireFirebaseAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required."
      });
    }

    const idToken = authHeader.substring(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Missing authentication token."
      });
    }

    const decodedToken = await getAuth().verifyIdToken(idToken, true);

    if (!decodedToken.email_verified) {
      return res.status(403).json({
        success: false,
        error: "Please verify your email before continuing."
      });
    }

    req.firebaseUser = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified
    };

    next();

  } catch (error) {
    console.error(
      "Firebase authentication error:",
      error.code || error.message
    );

    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token."
    });
  }
}

module.exports = requireFirebaseAuth;
