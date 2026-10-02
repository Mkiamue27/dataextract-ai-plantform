const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

require("dotenv").config();

const extractionRoutes = require("./routes/extraction");
const {
  PLAN_LIMITS,
} = require("./config/constants");

const app = express();
const port = process.env.PORT || 3000;


/* ============================================================
   SERVICES
============================================================ */

const stripe = new Stripe(
  process.env.STRIPE_API_KEY
);

const endpointSecret =
  process.env.STRIPE_WEBHOOK_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


/* ============================================================
   GENERAL MIDDLEWARE
============================================================ */

app.use(cors());


/* ============================================================
   SUBSCRIPTION HELPER
============================================================ */

async function upsertSubscription(
  subscription,
  status
) {
  const customerId =
    subscription.customer;

  const userId =
    subscription.metadata?.user_id ||
    null;

  const priceId =
    subscription.items?.data?.[0]
      ?.price?.id || null;


console.log("PRO env:", JSON.stringify(process.env.PRO_PRICE_ID));
console.log("PRICE received:", JSON.stringify(priceId));
console.log("PRO match:", priceId === process.env.PRO_PRICE_ID);

  const planName =
    priceId ===
    process.env.STARTER_PRICE_ID
      ? "starter"

      : priceId ===
        process.env.PRO_PRICE_ID
      ? "pro"

      : priceId ===
        process.env.BUSINESS_PRICE_ID
      ? "business"

      : "free";


  console.log(
    "Price ID received:",
    priceId
  );

  console.log(
    "Plan name resolved:",
    planName
  );

  console.log(
  "Subscription current_period_end:",
  subscription.current_period_end
);

console.log(
  "Subscription item current_period_end:",
  subscription.items?.data?.[0]?.current_period_end
);

  const payload = {
    firebase_uid: userId,

    stripe_customer_id:
      customerId,

    stripe_subscription_id:
      subscription.id,

    plan_name:
      planName,

    status,

    price_id:
      priceId,

    current_period_end:
  subscription.items?.data?.[0]?.current_period_end
    ? new Date(
        subscription.items.data[0].current_period_end *
          1000
      )
    : null,

    cancel_at_period_end:
      subscription.cancel_at_period_end ||
      false,

    updated_at:
      new Date(),
  };


  const { error } =
    await supabase
      .from("subscriptions")
      .upsert(
        payload,
        {
          onConflict:
            "stripe_customer_id",
        }
      );


  if (error) {

    console.error(
      "Supabase subscription upsert error:",
      error.message
    );

    throw error;

  } else {

    console.log(
      "Supabase subscription updated:",
      customerId
    );
  }
}


/* ============================================================
   STRIPE WEBHOOK
   IMPORTANT:
   Must stay BEFORE express.json()
============================================================ */

app.post(
  "/webhook",

  express.raw({
    type: "application/json",
  }),

  async (req, res) => {

    const sig =
      req.headers[
        "stripe-signature"
      ];

    let event;


    try {

      event =
        stripe.webhooks
          .constructEvent(
            req.body,
            sig,
            endpointSecret
          );

    } catch (error) {

      console.error(
        "Webhook verification failed:",
        error.message
      );

      return res
        .status(400)
        .send(
          `Webhook Error: ${error.message}`
        );
    }


    try {

      switch (event.type) {

        case "checkout.session.completed": {

          const session =
            event.data.object;

          console.log(
            "Checkout Completed"
          );


          if (session.subscription) {

            const subscription =
              await stripe
                .subscriptions
                .retrieve(
                  session.subscription
                );


            await upsertSubscription(
              subscription,
              "active"
            );
          }

          break;
        }


        case "customer.subscription.created": {

          const subscription =
            await stripe
              .subscriptions
              .retrieve(
                event.data.object.id
              );


          console.log(
            "Subscription Created"
          );


          await upsertSubscription(
            subscription,
            subscription.status
          );

          break;
        }


        case "customer.subscription.updated": {

          const subscription =
            event.data.object;


          console.log(
            "Subscription Updated"
          );


          await upsertSubscription(
            subscription,
            subscription.status
          );

          break;
        }


        case "customer.subscription.deleted": {

          const subscription =
            event.data.object;


          console.log(
            "Subscription Deleted"
          );


          await upsertSubscription(
            subscription,
            "canceled"
          );

          break;
        }


        default:

          console.log(
            `Unhandled Stripe event: ${event.type}`
          );
      }


      return res.json({
        received: true,
      });


    } catch (error) {

      console.error(
        "Webhook processing failed:",
        error
      );


      return res
        .status(500)
        .json({
          error:
            "Webhook processing failed.",
        });
    }
  }
);


/* ============================================================
   NORMAL JSON PARSER
   Must stay AFTER Stripe webhook
============================================================ */

app.use(
  express.json({
    limit: "25mb",
  })
);


/* ============================================================
   HEALTH ROUTES
============================================================ */

app.get("/", (req, res) => {

  res.send(
    "DataExtract AI API Running"
  );
});


app.get(
  "/health",

  (req, res) => {

    res.json({
      status: "ok",
      service:
        "DataExtract AI",

      timestamp:
        new Date().toISOString(),
    });
  }
);


/* ============================================================
   EXTRACTION ROUTES
============================================================ */

app.use(
  "/extract",
  extractionRoutes
);


/* ============================================================
   GET SUBSCRIPTION
============================================================ */

app.get(
  "/get-subscription",

  async (req, res) => {

    const { uid } =
      req.query;


    if (!uid) {

      return res
        .status(400)
        .json({
          error:
            "uid is required.",
        });
    }


    try {

      const {
        data,
        error,
      } =
        await supabase
          .from("subscriptions")
          .select(
            "plan_name, status, current_period_end, cancel_at_period_end"
          )
          .eq(
  "firebase_uid",
  uid
)
.order(
  "created_at",
  { ascending: false }
)
.limit(1)
.maybeSingle();


      if (error) {
        throw error;
      }


      if (!data) {

        return res.json({
          plan: "free",

          status:
            "inactive",

          current_period_end:
            null,

          cancel_at_period_end:
            false,
        });
      }


      return res.json({
        plan:
          data.plan_name ||
          "free",

        status:
          data.status ||
          "inactive",

        current_period_end:
          data.current_period_end,

        cancel_at_period_end:
          data.cancel_at_period_end,
      });


    } catch (error) {

      console.error(
        "Get subscription error:",
        error
      );


      return res
        .status(500)
        .json({
          error:
            "Unable to retrieve subscription.",
        });
    }
  }
);

/* ============================================================
   GET USAGE STATUS
============================================================ */

app.get(
  "/usage-status",

  async (req, res) => {
    const { uid } = req.query;

    if (!uid) {
      return res.status(400).json({
        allowed: false,
        error: "uid is required.",
      });
    }

    try {
      // Get subscription
      const {
  data: subscription,
  error: subscriptionError,
} = await supabase
  .from("subscriptions")
  .select("status, plan_name, created_at")
  .eq("firebase_uid", uid)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

      if (subscriptionError) {
        throw subscriptionError;
      }

      const plan =
        subscription &&
        subscription.status === "active"
          ? subscription.plan_name
          : "free";

      // Current month key: YYYY-MM
const currentMonth =
  new Date().toISOString().slice(0, 7);

// Get monthly usage
const {
  data: usage,
  error: usageError,
} = await supabase
  .from("usage")
  .select("conversions")
  .eq("firebase_uid", uid)
  .eq("month", currentMonth)
  .maybeSingle();

if (usageError) {
  throw usageError;
}

const used =
  Number(usage?.conversions || 0);

      const rawLimit =
  Object.prototype.hasOwnProperty.call(
    PLAN_LIMITS,
    plan
  )
    ? PLAN_LIMITS[plan]
    : PLAN_LIMITS.free;

const limit =
  rawLimit === Infinity
    ? null
    : rawLimit;

      const remaining =
        limit == null
          ? null
          : Math.max(limit - used, 0);

      const allowed =
        limit == null || used < limit;

      return res.json({
        allowed,
        plan,
        used,
        limit,
        remaining,
      });

    } catch (error) {
      console.error(
        "Usage status error:",
        error
      );

      return res.status(500).json({
        allowed: false,
        error:
          "Unable to retrieve usage status.",
      });
    }
  }
);
/* ============================================================
   CREATE CHECKOUT SESSION
============================================================ */

app.post(
  "/create-checkout-session",

  async (req, res) => {

    const {
      priceId,
      userId,
      successUrl,
      cancelUrl,
    } = req.body;


    if (
      !priceId ||
      !userId
    ) {

      return res
        .status(400)
        .json({
          error:
            "priceId and userId are required.",
        });
    }


    try {

      const session =
        await stripe
          .checkout
          .sessions
          .create({

            mode:
              "subscription",

            payment_method_types:
              ["card"],

            line_items: [
              {
                price:
                  priceId,

                quantity:
                  1,
              },
            ],

            subscription_data: {
              metadata: {
                user_id:
                  userId,
              },
            },

            success_url:
              successUrl ||
              "https://yourapp.com/success",

            cancel_url:
              cancelUrl ||
              "https://yourapp.com/cancel",
          });


      return res.json({
        url:
          session.url,
      });


    } catch (error) {

      console.error(
        "Checkout session error:",
        error
      );


      return res
        .status(500)
        .json({
          error:
            "Unable to create checkout session.",
        });
    }
  }
);

/* ============================================================
   CREATE STRIPE CUSTOMER PORTAL SESSION
============================================================ */

app.post(
  "/create-customer-portal-session",

  async (req, res) => {
    const {
      userId,
      returnUrl,
    } = req.body;

    if (!userId) {
      return res
        .status(400)
        .json({
          success: false,
          error: "userId is required.",
        });
    }

    try {
      /*
       * Find the user's Stripe customer ID
       * from the subscriptions table.
       */
      const {
        data: subscription,
        error: subscriptionError,
      } = await supabase
        .from("subscriptions")
        .select(
          "stripe_customer_id, created_at"
        )
        .eq("firebase_uid", userId)
        .not(
          "stripe_customer_id",
          "is",
          null
        )
        .order(
          "created_at",
          { ascending: false }
        )
        .limit(1)
        .maybeSingle();

      if (subscriptionError) {
        throw subscriptionError;
      }

      if (
        !subscription ||
        !subscription.stripe_customer_id
      ) {
        return res
          .status(404)
          .json({
            success: false,
            error:
              "No Stripe customer found for this user.",
          });
      }

      /*
       * Create Stripe Billing Portal session.
       */
      const portalSession =
        await stripe.billingPortal.sessions.create({
          customer:
            subscription.stripe_customer_id,

          return_url:
            returnUrl ||
            "https://yourapp.com/account",
        });

      return res.status(200).json({
        success: true,
        url: portalSession.url,
      });

    } catch (error) {
      console.error(
        "Customer portal session error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            error?.message ||
            "Unable to create customer portal session.",
        });
    }
  }
);

/* ============================================================
   DELETE ACCOUNT - STRIPE CLEANUP
============================================================ */

app.delete(
  "/account/delete",

  async (req, res) => {
    try {
      const firebaseUid =
        req.body?.firebase_uid;

      /* ========================================================
         VALIDATE USER
      ======================================================== */

      if (
        !firebaseUid ||
        String(firebaseUid).trim().length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: "firebase_uid is required.",
        });
      }

      const uid =
        String(firebaseUid).trim();

      console.log(
        "=== DATAEXTRACT ACCOUNT DELETE START ==="
      );

      /* ========================================================
         GET ALL STRIPE SUBSCRIPTION RECORDS
      ======================================================== */

      const {
        data: subscriptions,
        error: subscriptionError,
      } = await supabase
        .from("subscriptions")
        .select(
          "stripe_subscription_id, stripe_customer_id, status, created_at"
        )
        .eq("firebase_uid", uid);

      if (subscriptionError) {
        console.error(
          "Account delete subscription lookup error:",
          subscriptionError
        );

        return res.status(500).json({
          success: false,
          error:
            "Unable to retrieve subscription information.",
        });
      }

      /* ========================================================
         BUILD UNIQUE STRIPE SUBSCRIPTION ID LIST
      ======================================================== */

      const subscriptionIds = [
        ...new Set(
          (subscriptions || [])
            .map(
              (record) =>
                record.stripe_subscription_id
            )
            .filter(
              (subscriptionId) =>
                subscriptionId &&
                String(subscriptionId)
                  .trim()
                  .length > 0
            )
        ),
      ];

      console.log(
        "Stripe subscriptions found:",
        subscriptionIds.length
      );

      /* ========================================================
         CANCEL ALL EXISTING STRIPE SUBSCRIPTIONS
      ======================================================== */

      for (
        const subscriptionId
        of subscriptionIds
      ) {
        try {
          const stripeSubscription =
            await stripe.subscriptions.retrieve(
              subscriptionId
            );

          if (
            stripeSubscription.status !==
            "canceled"
          ) {
            await stripe.subscriptions.cancel(
              subscriptionId
            );

            console.log(
              "Stripe subscription canceled:",
              subscriptionId
            );
          } else {
            console.log(
              "Stripe subscription already canceled:",
              subscriptionId
            );
          }
        } catch (stripeError) {
          /*
           * If the subscription has already been removed
           * from Stripe, continue with account deletion.
           */
          if (
            stripeError?.code ===
            "resource_missing"
          ) {
            console.log(
              "Stripe subscription no longer exists; continuing:",
              subscriptionId
            );

            continue;
          }

          console.error(
            "Stripe cancellation error:",
            subscriptionId,
            stripeError
          );

          return res.status(500).json({
            success: false,
            error:
              "Unable to cancel one or more Stripe subscriptions.",
          });
        }
      }

      /* ========================================================
         DELETE CONVERSION HISTORY
      ======================================================== */

      const {
        error: historyError,
      } = await supabase
        .from("conversion_history")
        .delete()
        .eq("firebase_uid", uid);

      if (historyError) {
        console.error(
          "Account delete conversion_history error:",
          historyError
        );

        throw historyError;
      }

      /* ========================================================
         DELETE USAGE DATA
      ======================================================== */

      const {
        error: usageError,
      } = await supabase
        .from("usage")
        .delete()
        .eq("firebase_uid", uid);

      if (usageError) {
        console.error(
          "Account delete usage error:",
          usageError
        );

        throw usageError;
      }

      /* ========================================================
         DELETE FEEDBACK
      ======================================================== */

      const {
        error: feedbackError,
      } = await supabase
        .from("feedback")
        .delete()
        .eq("firebase_uid", uid);

      if (feedbackError) {
        console.error(
          "Account delete feedback error:",
          feedbackError
        );

        throw feedbackError;
      }

      /* ========================================================
         DELETE SUBSCRIPTION RECORDS
      ======================================================== */

      const {
        error: deleteSubscriptionError,
      } = await supabase
        .from("subscriptions")
        .delete()
        .eq("firebase_uid", uid);

      if (deleteSubscriptionError) {
        console.error(
          "Account delete subscriptions error:",
          deleteSubscriptionError
        );

        throw deleteSubscriptionError;
      }

      /* ========================================================
         SUCCESS
      ======================================================== */

      console.log(
        "=== DATAEXTRACT ACCOUNT DELETE COMPLETE ==="
      );

      return res.status(200).json({
        success: true,
        message:
          "DataExtract AI account data deleted successfully.",
      });

    } catch (error) {
      console.error(
        "Account delete error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Unable to delete account data.",
      });
    }
  }
);

/* ============================================================
   SUBMIT USER FEEDBACK
============================================================ */

app.post(
  "/feedback",

  async (req, res) => {
    const {
      firebase_uid,
      feedback_type,
      reason,
      extraction_id,
    } = req.body;

    // Required fields
    if (!firebase_uid || !feedback_type) {
      return res.status(400).json({
        success: false,
        error:
          "firebase_uid and feedback_type are required.",
      });
    }

    // Only allow the feedback types used by the app
    if (
      feedback_type !== "helpful" &&
      feedback_type !== "not_helpful"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "feedback_type must be helpful or not_helpful.",
      });
    }

    try {
      const { data, error } =
        await supabase
          .from("feedback")
          .insert({
            firebase_uid,
            feedback_type,
            reason: reason || null,
            extraction_id:
              extraction_id || null,
          })
          .select()
          .single();

      if (error) {
        throw error;
      }

      console.log(
        "Feedback submitted:",
        feedback_type,
        firebase_uid
      );

      return res.status(201).json({
        success: true,
        feedback: data,
      });

    } catch (error) {
      console.error(
        "Feedback submission error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to submit feedback.",
      });
    }
  }
);

/* ============================================================
   404 HANDLER
============================================================ */

app.use(
  (req, res) => {

    res.status(404).json({
      success: false,

      error:
        "Route not found.",
    });
  }
);


/* ============================================================
   SERVER
============================================================ */

app.listen(
  port,

  () => {

    console.log(
      `DataExtract AI server listening on port ${port}`
    );
  }
);
