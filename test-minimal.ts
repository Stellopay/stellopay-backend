import { Router } from "express";
const r = Router();
r.post(
  "/path",
  async (req, res, next) => {
    try {
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: String(e) });
    } finally {
      console.log("done");
    }
  },
);
