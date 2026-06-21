import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config (so importing the route does not require STARKNET_RPC_URL) and
// nodemailer (so no real email is ever sent). env is mutable per-test.
const { envMock, sendMail } = vi.hoisted(() => ({
  envMock: {
    NODE_ENV: "development",
    EMAIL_USER: undefined as string | undefined,
    EMAIL_PASSWORD: undefined as string | undefined,
    CONTACT_RECIPIENT_EMAIL: undefined as string | undefined,
  },
  sendMail: vi.fn(),
}));

vi.mock("../config.js", () => ({ env: envMock }));
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { contactRouter } from "./contact";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", contactRouter);
  return app;
}

const valid = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  message: "Hello there",
};

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({});
  envMock.NODE_ENV = "development";
  envMock.EMAIL_USER = undefined;
  envMock.EMAIL_PASSWORD = undefined;
  envMock.CONTACT_RECIPIENT_EMAIL = undefined;
});

describe("POST /contact/send-message", () => {
  it("rejects missing fields with 400 and does not send", async () => {
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ firstName: "Ada" });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects an oversized message with 400", async () => {
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ ...valid, message: "x".repeat(5001) });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("rejects an invalid email with 400", async () => {
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ ...valid, email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("dev-mode without credentials returns success without sending", async () => {
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("production without a recipient returns 503 (no hardcoded address)", async () => {
    envMock.NODE_ENV = "production";
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    // CONTACT_RECIPIENT_EMAIL intentionally left unset
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(503);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("HTML-escapes user input and sends to the configured env recipient", async () => {
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    const res = await request(makeApp())
      .post("/api/v1/contact/send-message")
      .send({ ...valid, message: "<script>alert(1)</script>" });

    expect(res.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("team@stellopay.com");
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.html).not.toContain("<script>");
  });

  it("returns 500 when sending fails", async () => {
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to send/);
  });

  it("in production, a send failure returns 500 without leaking error details", async () => {
    envMock.NODE_ENV = "production";
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(500);
    expect(res.body.details).toBeUndefined();
  });

  it("handles a non-Error rejection (no .message) and still returns 500", async () => {
    envMock.EMAIL_USER = "sender@gmail.com";
    envMock.EMAIL_PASSWORD = "app-password";
    envMock.CONTACT_RECIPIENT_EMAIL = "team@stellopay.com";
    sendMail.mockRejectedValueOnce("smtp exploded"); // a thrown string, not an Error
    const res = await request(makeApp()).post("/api/v1/contact/send-message").send(valid);
    expect(res.status).toBe(500);
  });
});
