import express from "express";
import nodemailer from "nodemailer";
import { z } from "zod";
import { env } from "../config.js";

const contactRouter = express.Router();

const ContactBody = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  message: z.string().trim().min(1).max(5000),
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /api/v1/contact/send-message
contactRouter.post("/contact/send-message", async (req, res, next) => {
  try {
    const parsed = ContactBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues,
      });
      return;
    }

    const { firstName, lastName, email, message } = parsed.data;

    // Check if email credentials are configured
    if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) {
      console.warn("[contact] Email credentials not configured. Message would be sent to:", {
        firstName,
        lastName,
        email,
        message: message.substring(0, 100) + (message.length > 100 ? "..." : ""),
      });
      if (env.NODE_ENV === "development") {
        res.json({
          success: true,
          message: "Your message has been received (email not configured in development)",
        });
        return;
      }
      res.status(503).json({
        error: "Email service is not configured. Please contact support directly.",
      });
      return;
    }

    const recipient = env.CONTACT_RECIPIENT_EMAIL ?? env.EMAIL_USER;

    const safeFirst = escapeHtml(firstName);
    const safeLast = escapeHtml(lastName);
    const safeEmail = escapeHtml(email);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: env.EMAIL_USER,
      to: recipient,
      subject: `Contact Form Submission from ${safeFirst} ${safeLast}`,
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${safeFirst} ${safeLast}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Message:</strong></p>
        <p>${safeMessage}</p>
      `,
      text: `New Contact Form Submission\n\nName: ${firstName} ${lastName}\nEmail: ${email}\n\nMessage:\n${message}`,
    });

    res.json({ success: true, message: "Your message has been sent successfully!" });
  } catch (error: any) {
    console.error("[contact] Failed to send email:", error);
    next(error);
  }
});

export { contactRouter };
