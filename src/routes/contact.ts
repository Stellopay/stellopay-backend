import express from "express";
import nodemailer from "nodemailer";
import { env } from "../config.js";

const contactRouter = express.Router();

// POST /api/v1/contact/send-message
contactRouter.post("/contact/send-message", async (req, res) => {
  try {
    const { firstName, lastName, email, message } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !message) {
      return res.status(400).json({
        error: "Missing required fields: firstName, lastName, email, and message are required",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: "Invalid email format",
      });
    }

    // Check if email credentials are configured
    if (!env.EMAIL_USER || !env.EMAIL_PASSWORD) {
      console.warn("[contact] Email credentials not configured. Message would be sent to:", {
        firstName,
        lastName,
        email,
        message: message.substring(0, 100) + "...",
      });
      // In development, return success even without email configured
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

    // Create transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: env.EMAIL_USER,
        pass: env.EMAIL_PASSWORD,
      },
    });

    // Email content
    const mailOptions = {
      from: env.EMAIL_USER,
      to: "jagadeesh26062002@gmail.com",
      subject: `Contact Form Submission from ${firstName} ${lastName}`,
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>Name:</strong> ${firstName} ${lastName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, "<br>")}</p>
      `,
      text: `
New Contact Form Submission

Name: ${firstName} ${lastName}
Email: ${email}

Message:
${message}
      `,
    };

    // Send email
    await transporter.sendMail(mailOptions);

    res.json({
      success: true,
      message: "Your message has been sent successfully!",
    });
  } catch (error: any) {
    console.error("[contact] Failed to send email:", error);
    res.status(500).json({
      error: "Failed to send message. Please try again later.",
      details: env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

export { contactRouter };

