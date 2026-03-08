import { Router, Request, Response } from "express";
import { identifyContact } from "../services/contact.service";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const { email, phoneNumber } = req.body;

  // At least one identifier must be present to do anything meaningful.
  if (!email && phoneNumber == null) {
    res.status(400).json({ error: "Provide at least one of email or phoneNumber." });
    return;
  }

  // phoneNumber can arrive as a number per the spec — normalise to string.
  const phone = phoneNumber != null ? String(phoneNumber) : undefined;
  const mail = email ? String(email) : undefined;

  try {
    const contact = await identifyContact({ email: mail, phoneNumber: phone });
    res.status(200).json({ contact });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error." });
  }
});

export default router;
