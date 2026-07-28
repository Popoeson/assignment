require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");

const app = express();
const { createClient } = require('@supabase/supabase-js');

/* ---------- MIDDLEWARE ---------- */
app.use(cors());
app.use(express.json());

/* -------- SUPABASE SETUP -------*/
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- MONGODB CONNECTION ---------- */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

/* ---------- COURSE / TIER / PRICE MAP (single source of truth) ---------- */
// Add new courses here later when the two pages get merged into one.
const COURSES = {
  "Computer Appreciation II": { tier: "standard", pricePerFile: 500 },
  "Data Science":             { tier: "premium",  pricePerFile: 1000 },
  "Web Design":                { tier: "premium",  pricePerFile: 1000 }
};

/* ---------- SCHEMAS ---------- */
const tokenSchema = new mongoose.Schema({
  token: { type: String, unique: true },
  tier: { type: String, enum: ["standard", "premium"] }, // undefined = legacy/admin-generated, tier check is skipped for these
  reference: { type: String, unique: true, sparse: true }, // which payment this token was issued for
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const submissionSchema = new mongoose.Schema({
  name: String,
  department: String,
  course: String,
  phone: String,
  email: String,

  files: [{
    fileUrl: String,
    fileName: String
  }],

  fileCount: Number,
  amountPaid: Number,
  paymentRef: String,
  score: Number,
  token: String,
  submittedAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  name: String,
  email: String,
  course: String,
  tier: String,
  amount: Number,
  reference: { type: String, unique: true },
  status: { type: String, enum: ["success", "failed"], default: "success" },
  paidAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const Token = mongoose.model("Token", tokenSchema);
const Submission = mongoose.model("Submission", submissionSchema);
const Transaction = mongoose.model("Transaction", transactionSchema);

/* ---------- MULTER SETUP ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

/* ---------- HELPERS ---------- */
function generateTokenString() {
  return `ICT-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
}

/* ---------- TOKEN VALIDATION ---------- */
app.post("/api/tokens/validate", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Token is required" });

    const tokenDoc = await Token.findOne({ token });
    if (!tokenDoc) return res.status(400).json({ message: "Invalid token" });
    if (tokenDoc.used) return res.status(400).json({ message: "Token already used" });

    res.json({ message: "Token valid", tier: tokenDoc.tier || null });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- PAYSTACK: INITIALIZE (server-side, with split, course-aware pricing) ---------- */
app.post("/api/payment/initialize", async (req, res) => {
  try {
    const { email, name, course, fileCount, callback_url } = req.body;

    if (!email || !name || !course || !fileCount) {
      return res.status(400).json({ message: "email, name, course and fileCount are required" });
    }

    const courseInfo = COURSES[course];
    if (!courseInfo) {
      return res.status(400).json({ message: "Invalid course selected" });
    }

    const count = Number(fileCount);
    if (!count || count < 1 || count > 5) {
      return res.status(400).json({ message: "Invalid file count" });
    }

    const amount = count * courseInfo.pricePerFile; // Naira, priced server-side — never trust a client-sent amount

    const payload = {
      email,
      amount: amount * 100, // kobo
      callback_url,
      metadata: { name, course, tier: courseInfo.tier, fileCount: count }
    };

    if (process.env.PAYSTACK_SPLIT_CODE) {
      payload.split_code = process.env.PAYSTACK_SPLIT_CODE;
    }

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const { authorization_url, access_code, reference } = response.data.data;

    res.json({ authorization_url, access_code, reference, amount });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: "Payment initialization failed" });
  }
});

/* ---------- PAYSTACK: VERIFY + AUTO-ISSUE TOKEN ---------- */
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference, name, email } = req.body;
    if (!reference) return res.status(400).json({ message: "Reference is required" });

    // Idempotency: if this reference was already verified, return the same token again
    // instead of minting a new one (handles refreshes on the return page).
    const existingTxn = await Transaction.findOne({ reference });
    if (existingTxn && existingTxn.status === "success") {
      const existingToken = await Token.findOne({ reference });
      return res.json({
        verified: true,
        amount: existingTxn.amount,
        tier: existingTxn.tier,
        token: existingToken ? existingToken.token : null
      });
    }

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const data = response.data.data;
    if (data.status !== "success") {
      return res.status(400).json({ message: "Payment not successful" });
    }

    const amount = data.amount / 100;
    const meta = data.metadata || {};
    const course = meta.course;
    const tier = meta.tier;

    await Transaction.create({
      name,
      email,
      course,
      tier,
      amount,
      reference,
      status: "success",
      paidAt: new Date(data.paid_at)
    });

    // Auto-issue a token tied to this payment, scoped to its tier
    const tokenStr = generateTokenString();
    await Token.create({ token: tokenStr, tier, reference, used: false });

    res.json({ verified: true, amount, tier, token: tokenStr });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ message: "Payment verification failed" });
  }
});

/* ---------- ASSIGNMENT SUBMISSION ---------- */
app.post("/api/submissions", upload.array("file", 5), async (req, res) => {
  try {
    const { name, department, course, phone, email, token, paymentRef } = req.body;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const courseInfo = COURSES[course];
    if (!courseInfo) {
      return res.status(400).json({ message: "Invalid course selected" });
    }

    /* ---------- TOKEN CHECK ---------- */
    const tokenDoc = await Token.findOne({ token });
    if (!tokenDoc || tokenDoc.used) {
      return res.status(400).json({ message: "Invalid or used token" });
    }

    /* ---------- TIER LOCK: a standard token can't submit a premium course & vice versa ---------- */
    // tokenDoc.tier is undefined for legacy/manually-generated tokens — those skip the check.
    if (tokenDoc.tier && tokenDoc.tier !== courseInfo.tier) {
      return res.status(400).json({ message: "This token is not valid for the selected course" });
    }

    const uploadedFiles = [];

    /* ---------- SUPABASE UPLOAD ---------- */
    for (const file of req.files) {
      const filePath = `submissions/${Date.now()}_${file.originalname}`;

      const { error: uploadError } = await supabase
        .storage
        .from("assignments")
        .upload(filePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });

      if (uploadError) {
        console.error("Supabase upload error:", uploadError);
        throw uploadError;
      }

      const { data: publicData } = supabase
        .storage
        .from("assignments")
        .getPublicUrl(filePath);

      uploadedFiles.push({
        fileUrl: publicData.publicUrl,
        fileName: file.originalname
      });
    }

    /* ---------- CALCULATIONS ---------- */
    const fileCount = uploadedFiles.length;
    const amountPaid = fileCount * courseInfo.pricePerFile;
    const score = Math.floor(Math.random() * 7) + 13;

    /* ---------- SAVE SUBMISSION ---------- */
    const submission = await Submission.create({
      name,
      department,
      course,
      phone,
      email,
      files: uploadedFiles,
      fileCount,
      amountPaid,
      paymentRef,
      score,
      token
    });

    /* ---------- MARK TOKEN USED ---------- */
    tokenDoc.used = true;
    await tokenDoc.save();

    res.json({
      message: "Submission successful",
      score,
      submission
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Submission failed",
      error: err.message
    });
  }
});

/* ---------- ADMIN ROUTES ---------- */
app.get("/api/submissions", async (_, res) => {
  const submissions = await Submission.find().sort({ submittedAt: -1 });
  res.json(submissions);
});

app.get("/api/tokens", async (_, res) => {
  const tokens = await Token.find().sort({ createdAt: -1 });
  res.json(tokens);
});

app.get("/api/transactions", async (_, res) => {
  try {
    const transactions = await Transaction.find().sort({ createdAt: -1 });
    res.json(transactions);
  } catch {
    res.status(500).json({ message: "Failed to fetch transactions" });
  }
});

// Manual token generation still available as an admin fallback (e.g. for edge cases,
// refunds handled outside Paystack, etc). These come out tier-less, so the tier lock
// in /api/submissions is skipped for them — they work for any course.
app.post("/api/tokens/generate", async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0)
    return res.status(400).json({ message: "Invalid amount" });

  const tokens = [];
  for (let i = 0; i < amount; i++) {
    tokens.push(await Token.create({ token: generateTokenString() }));
  }
  res.json(tokens);
});

/* ---------- HEALTH ---------- */
app.get("/", (_, res) => res.send("Assignment Submission API running"));

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
