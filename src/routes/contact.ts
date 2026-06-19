import express from "express";
import nodemailer from "nodemailer";
import { z } from "zod";
import { env } from "../config.js";

const contactRouter = express.Router();

/**
 * Validation schema for the contact form. Trims input and caps each field's
 * length to prevent unbounded, unchecked input and large-payload abuse.
 */
const ContactBody = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  message: z.string().trim().min(1).max(5000),
});

/**
 * Escapes HTML-significant characters so user-provided values cannot inject
 * markup or extra content into the HTML email body.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /api/v1/contact/send-message
contactRouter.post("/contact/send-message", async (req, res) => {
  try {
    const parsed = ContactBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: parsed.error.issues,
      });
    }
    const { firstName, lastName, email, message } = parsed.data;

    const recipient = env.CONTACT_RECIPIENT_EMAIL;

    // Email is sent only when SMTP credentials AND a recipient are configured.
    // Otherwise keep the dev-mode "received" behaviour and fail closed in
    // production — never fall back to a hardcoded personal address.
    if (!env.EMAIL_USER || !env.EMAIL_PASSWORD || !recipient) {
      // Log minimally: never echo credentials or the full message body.
      console.warn(
        "[contact] Email not configured (missing credentials or CONTACT_RECIPIENT_EMAIL); message not sent.",
      );
      if (env.NODE_ENV === "development") {
        return res.json({
          success: true,
          message: "Your message has been received (email not configured in development)",
        });
      }
      return res.status(503).json({
        error: "Email service is not configured. Please contact support directly.",
      });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASSWORD,
      },
    });

    const safeFirstName = escapeHtml(firstName);
    const safeLastName = escapeHtml(lastName);
    const safeEmail = escapeHtml(email);
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

    const mailOptions = {
      from: env.EMAIL_USER,
      to: recipient,
      subject: `Contact Form Submission from ${firstName} ${lastName}`,
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${safeFirstName} ${safeLastName}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Message:</strong></p>
        <p>${safeMessage}</p>
      `,
      text: `New Contact Form Submission

Name: ${firstName} ${lastName}
Email: ${email}

Message:
${message}
`,
    };

    await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: "Your message has been sent successfully!",
    });
  } catch (error: any) {
    console.error("[contact] Failed to send email:", error?.message ?? error);
    res.status(500).json({
      error: "Failed to send message. Please try again later.",
      details: env.NODE_ENV === "development" ? error?.message : undefined,
    });
  }
});

export { contactRouter };
