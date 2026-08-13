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
  const {
    firebase_uid,
  } = req.body;


  /* ============================================================
     VALIDATE FIREBASE UID
  ============================================================ */

 if (
  !firebase_uid ||
  firebase_uid.trim().length === 0
) {
  return res.status(400).json({
    success: false,
    error: "Missing firebase_uid",
  });
}


  try {

    /* ============================================================
       GET CURRENT SUBSCRIPTION
    ============================================================ */

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
        firebase_uid.trim()
      )
      .maybeSingle();


    if (subscriptionError) {
      throw subscriptionError;
    }


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
        firebase_uid.trim()
      )
      .maybeSingle();


    if (usageError) {
      throw usageError;
    }


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


    /* ============================================================
       COUNT INCOMING FILES
    ============================================================ */

    const incomingFilesCount =
      Array.isArray(req.files)
        ? req.files.length
        : 0;


    if (
      incomingFilesCount <= 0
    ) {
      return res.status(400).json({
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


      return res.status(403).json({
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


    return next();


  } catch (error) {

    console.error(
      "Usage limit verification error:",
      error
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
