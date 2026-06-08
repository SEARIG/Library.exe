import { app } from "./firebase-config.js";
import { showToast } from "./toast.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

const BASE_FEE = 999;
const BOOK_RATE = 3;
const STUDENT_RATE = 3;
const UNLIMITED_MONTHLY = 6999;
const functions = getFunctions(app);

const form = document.querySelector("#registrationForm");
const statusBox = document.querySelector("#registrationStatus");
const pricePreview = document.querySelector("#pricePreview");

function money(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(value);
}

function getSelected(name) {
  return form.querySelector(`[name="${name}"]:checked`)?.value;
}

function calculatePrice() {
  const planType = getSelected("planType");
  const billingCycle = document.querySelector("#billingCycle").value;
  const bookCount = Number(document.querySelector("#bookCount").value || 0);
  const studentCount = Number(document.querySelector("#studentCount").value || 0);
  const monthlyAmount = planType === "custom"
    ? BASE_FEE + (bookCount * BOOK_RATE) + (studentCount * STUDENT_RATE)
    : UNLIMITED_MONTHLY;
  const finalAmount = billingCycle === "yearly"
    ? Math.round(monthlyAmount * 12 * 0.9)
    : monthlyAmount;

  return {
    planType,
    billingCycle,
    bookCount,
    studentCount,
    baseFee: planType === "custom" ? BASE_FEE : 0,
    bookRate: planType === "custom" ? BOOK_RATE : 0,
    studentRate: planType === "custom" ? STUDENT_RATE : 0,
    monthlyAmount,
    yearlyAmount: monthlyAmount * 12,
    discountPercent: billingCycle === "yearly" ? 10 : 0,
    finalAmount
  };
}

function renderPrice() {
  const price = calculatePrice();
  pricePreview.textContent = `${money(price.finalAmount)}/${price.billingCycle === "yearly" ? "year" : "month"}`;
}

function setLoading(isLoading) {
  form.querySelectorAll("button, input, select, textarea").forEach((field) => {
    field.disabled = isLoading;
  });
}

function setStatus(message, type = "success") {
  statusBox.textContent = message;
  statusBox.className = `auth-message ${type}`;
}

function collectPayload() {
  return {
    orgType: getSelected("orgType"),
    organizationName: document.querySelector("#organizationName").value.trim(),
    email: document.querySelector("#email").value.trim(),
    phone: document.querySelector("#phone").value.trim(),
    address: document.querySelector("#address").value.trim(),
    authorizedPerson: document.querySelector("#authorizedPerson").value.trim(),
    admin: {
      name: document.querySelector("#adminName").value.trim(),
      email: document.querySelector("#adminEmail").value.trim(),
      phone: document.querySelector("#adminPhone").value.trim(),
      password: document.querySelector("#adminPassword").value
    },
    pricing: calculatePrice()
  };
}

async function finalizeRegistration(payload, payment) {
  const completeRegistration = httpsCallable(functions, "completeOrganizationRegistration");
  const result = await completeRegistration({
    ...payload,
    payment
  });
  return result.data;
}

function runRazorpayCheckout(subscription, payload) {
  return new Promise((resolve, reject) => {
    if (!window.Razorpay || subscription.mode === "demo") {
      resolve({
        razorpay_subscription_id: subscription.subscriptionId || `demo_sub_${Date.now()}`,
        razorpay_payment_id: `demo_pay_${Date.now()}`,
        razorpay_signature: "demo_signature",
        mode: "demo"
      });
      return;
    }

    const checkout = new window.Razorpay({
      key: subscription.keyId,
      name: "Universal Library Cloud",
      description: `${payload.organizationName} ${payload.pricing.billingCycle} subscription`,
      subscription_id: subscription.subscriptionId,
      prefill: {
        name: payload.admin.name,
        email: payload.admin.email,
        contact: payload.admin.phone
      },
      handler: resolve,
      modal: {
        ondismiss: () => reject(new Error("Payment was cancelled."))
      },
      theme: {
        color: "#1c6f57"
      }
    });

    checkout.open();
  });
}

form?.addEventListener("input", renderPrice);
form?.addEventListener("change", renderPrice);

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoading(true);
  setStatus("Creating subscription...", "success");

  try {
    const payload = collectPayload();
    const createSubscription = httpsCallable(functions, "createRazorpaySubscription");
    const subscription = (await createSubscription(payload)).data;
    const payment = await runRazorpayCheckout(subscription, payload);
    setStatus("Payment received. Creating organization...", "success");
    const result = await finalizeRegistration(payload, payment);
    showToast("Organization created. Login with the main admin account.", "success");
    window.location.href = `login.html?created=${encodeURIComponent(result.organizationId)}`;
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Registration failed.", "error");
    showToast(error.message || "Registration failed.", "error");
  } finally {
    setLoading(false);
  }
});

renderPrice();
