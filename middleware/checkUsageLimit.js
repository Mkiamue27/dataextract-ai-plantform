const { createClient } = require("@supabase/supabase-js");

const {
  PLAN_LIMITS,
} = require("../config/constants");


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


/* ============================================================
   CHECK USAGE LIMIT
============================================================ */

async function checkUsageLimit(
  req,
  res,
  next
) {

  console.log(
    "=== CHECK USAGE LIMIT STARTED ==="
  );


  const {
    firebase_uid,
  } = req.body || {};


  /* ============================================================
     VALIDATE FIREBASE UID
  ============================================================ */

  if (
    !firebase_uid ||
    firebase_uid.trim().length === 0
  ) {

    console.warn(
      "Usage check stopped: firebase_uid missing."
    );

    return res
      .status(400)
      .json({
        success: false,
        error: "Missing firebase_uid",
      });
  }


  const cleanFirebaseUid =
    firebase_uid.trim();


  console.log(
    "Firebase UID received:",
    Boolean(cleanFirebaseUid)
  );


  try {

    /* ============================================================
       GET CURRENT SUBSCRIPTION
    ============================================================ */

    console.log(
      "Looking up subscriptions table..."
    );


    const {
      data: subscription,
      error: subscriptionError,
    } = await supabase
      .from("subscriptions")
      .select(
        "status, plan_name"
      )
      .eq(
        "firebase_uid",
        cleanFirebaseUid
      )
      .maybeSingle();


    if (subscriptionError) {

      console.error(
        "Subscription lookup failed:",
        subscriptionError
      );

      throw subscriptionError;
    }


    console.log(
      "Subscription lookup completed."
    );

    console.log(
      "Subscription found:",
      Boolean(subscription)
    );


    /* ============================================================
       DETERMINE CURRENT PLAN
    ============================================================ */

    const currentPlan =
      subscription &&
      (
        subscription.status === "active" ||
        subscription.status === "trialing"
      )
        ? (
            subscription.plan_name ||
            "free"
          )
        : "free";


    console.log(
      "Resolved plan:",
      currentPlan
    );


    /* ============================================================
       GET PLAN LIMIT
    ============================================================ */

    const planLimit =
      Object.prototype.hasOwnProperty.call(
        PLAN_LIMITS,
        currentPlan
      )
        ? PLAN_LIMITS[currentPlan]
        : PLAN_LIMITS.free;


    console.log(
      "Resolved plan limit:",
      planLimit === Infinity
        ? "unlimited"
        : planLimit
    );


    /*
     * Infinity means the current plan has
     * no conversion cap.
     */
    if (planLimit === Infinity) {

      req.currentPlan =
        currentPlan;

      req.currentUsage =
        null;

      req.usageLimit =
        null;


      console.log(
        "Unlimited plan. Usage check passed."
      );

      return next();
    }


    /* ============================================================
       CURRENT MONTH
    ============================================================ */

    const currentMonth =
      new Date()
        .toISOString()
        .slice(0, 7);


    /* ============================================================
       GET CURRENT USAGE
    ============================================================ */

    console.log(
      "Looking up usage table..."
    );


    const {
      data: usage,
      error: usageError,
    } = await supabase
      .from("usage")
      .select(
        "month, conversions"
      )
      .eq(
        "firebase_uid",
        cleanFirebaseUid
      )
      .maybeSingle();


    if (usageError) {

      console.error(
        "Usage lookup failed:",
        usageError
      );

      throw usageError;
    }


    console.log(
      "Usage lookup completed."
    );


    let currentUsage = 0;


    if (
      usage &&
      usage.month === currentMonth
    ) {

      currentUsage =
        Number(
          usage.conversions || 0
        );
    }


    console.log(
      "Current monthly usage:",
      currentUsage
    );


    /* ============================================================
       COUNT INCOMING FILES
    ============================================================ */

    const incomingFilesCount =
      Array.isArray(req.files)
        ? req.files.length
        : 0;


    console.log(
      "Incoming files:",
      incomingFilesCount
    );


    if (
      incomingFilesCount <= 0
    ) {

      console.warn(
        "Usage check stopped: no files received."
      );

      return res
        .status(400)
        .json({
          success: false,
          error: "No files uploaded.",
        });
    }


    /* ============================================================
       PROJECT USAGE
    ============================================================ */

    const projectedUsage =
      currentUsage +
      incomingFilesCount;


    console.log(
      "Projected usage:",
      projectedUsage
    );


    if (
      projectedUsage >
      planLimit
    ) {

      const remaining =
        Math.max(
          planLimit -
            currentUsage,
          0
        );


      console.warn(
        "Usage limit reached."
      );


      return res
        .status(403)
        .json({
          success: false,

          error:
            "Limit reached",

          message:
            `You have ${remaining} extraction(s) remaining this month, ` +
            `but you uploaded ${incomingFilesCount} file(s). ` +
            `Please reduce the batch size or upgrade your plan.`,

          limitReached:
            true,

          plan:
            currentPlan,

          currentUsage,

          limit:
            planLimit,

          incomingFiles:
            incomingFilesCount,

          projectedUsage,

          remaining,
        });
    }


    /* ============================================================
       ATTACH USAGE DATA TO REQUEST
    ============================================================ */

    req.currentPlan =
      currentPlan;

    req.currentUsage =
      currentUsage;

    req.usageLimit =
      planLimit;

    req.projectedUsage =
      projectedUsage;


    console.log(
      "=== USAGE CHECK PASSED ==="
    );


    return next();


  } catch (error) {

    console.error(
      "=== USAGE LIMIT VERIFICATION ERROR ==="
    );

    console.error(
      "Message:",
      error?.message ||
      error
    );

    console.error(
      "Code:",
      error?.code ||
      "none"
    );

    console.error(
      "Details:",
      error?.details ||
      "none"
    );


    return res
      .status(500)
      .json({
        success: false,

        error:
          "Usage verification failed.",
      });
  }
}


module.exports =
  checkUsageLimit;
