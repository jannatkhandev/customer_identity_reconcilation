import { Contact } from "@prisma/client";
import prisma from "../lib/prisma";

interface IdentifyInput {
  email?: string;
  phoneNumber?: string;
}

interface IdentifyResult {
  primaryContatctId: number; // keeping the typo from the spec
  emails: string[];
  phoneNumbers: string[];
  secondaryContactIds: number[];
}

export async function identifyContact({ email, phoneNumber }: IdentifyInput): Promise<IdentifyResult> {
  // Wrap everything in a transaction so concurrent requests don't create duplicate primaries
  // or produce inconsistent cluster state.
  return prisma.$transaction(async (tx) => {

    // --- Step 1: Find all existing contacts that share the incoming email or phone ---
    const orConditions = [];
    if (email) orConditions.push({ email });
    if (phoneNumber) orConditions.push({ phoneNumber });

    const matches = await tx.contact.findMany({
      where: { deletedAt: null, OR: orConditions },
    });

    // No matches → brand new customer, create a primary and return.
    if (matches.length === 0) {
      const created = await tx.contact.create({
        data: {
          email: email ?? null,
          phoneNumber: phoneNumber ?? null,
          linkPrecedence: "primary",
        },
      });
      return buildResponse(created, []);
    }

    // --- Step 2: Resolve the primary contact for each matched contact ---
    // Each match is either a primary itself or a secondary pointing to one.
    // Collect the unique set of primary IDs across all matches.
    const primaryIds = new Set<number>();
    for (const contact of matches) {
      if (contact.linkPrecedence === "primary") {
        primaryIds.add(contact.id);
      } else if (contact.linkedId !== null) {
        primaryIds.add(contact.linkedId);
      }
    }

    // Fetch the actual primary records and sort oldest-first.
    // The oldest primary is the canonical root of this identity.
    const primaries = await tx.contact.findMany({
      where: { id: { in: [...primaryIds] }, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });

    const [oldestPrimary, ...newerPrimaries] = primaries;

    // --- Step 3: Merge clusters if the request linked two previously separate identities ---
    // Example: contact A (email) and contact B (phone) were both primaries of their own
    // clusters. A new request arrives with A's email AND B's phone — they're the same person.
    // → Demote B (and any future newer primaries) to secondary under A.
    if (newerPrimaries.length > 0) {
      const newerPrimaryIds = newerPrimaries.map((p) => p.id);

      // Demote the newer primaries themselves.
      await tx.contact.updateMany({
        where: { id: { in: newerPrimaryIds } },
        data: {
          linkPrecedence: "secondary",
          linkedId: oldestPrimary.id,
          updatedAt: new Date(),
        },
      });

      // Re-parent any secondaries that were under the now-demoted primaries.
      await tx.contact.updateMany({
        where: { linkedId: { in: newerPrimaryIds } },
        data: { linkedId: oldestPrimary.id, updatedAt: new Date() },
      });
    }

    // --- Step 4: Fetch the full consolidated cluster ---
    const allContacts = await tx.contact.findMany({
      where: {
        deletedAt: null,
        OR: [{ id: oldestPrimary.id }, { linkedId: oldestPrimary.id }],
      },
    });

    // --- Step 5: Create a secondary if the request contains new information ---
    // "New information" means an email or phone that doesn't already exist in the cluster.
    // This handles cases like: same phone, but a new email we've never seen before.
    const existingEmails = new Set(allContacts.map((c) => c.email).filter(Boolean));
    const existingPhones = new Set(allContacts.map((c) => c.phoneNumber).filter(Boolean));

    const hasNewEmail = email && !existingEmails.has(email);
    const hasNewPhone = phoneNumber && !existingPhones.has(phoneNumber);

    if (hasNewEmail || hasNewPhone) {
      const newSecondary = await tx.contact.create({
        data: {
          email: email ?? null,
          phoneNumber: phoneNumber ?? null,
          linkedId: oldestPrimary.id,
          linkPrecedence: "secondary",
        },
      });
      allContacts.push(newSecondary);
    }

    // Build and return the response.
    const secondaries = allContacts.filter((c) => c.id !== oldestPrimary.id);
    return buildResponse(oldestPrimary, secondaries);
  });
}

// Formats the consolidated cluster into the response shape the spec requires.
// Primary's email and phone always come first in their respective arrays.
function buildResponse(primary: Contact, secondaries: Contact[]): IdentifyResult {
  const emails = dedupe([
    primary.email,
    ...secondaries.map((c) => c.email),
  ]);

  const phoneNumbers = dedupe([
    primary.phoneNumber,
    ...secondaries.map((c) => c.phoneNumber),
  ]);

  return {
    primaryContatctId: primary.id,
    emails,
    phoneNumbers,
    secondaryContactIds: secondaries.map((c) => c.id),
  };
}

// Removes nulls and duplicates while preserving insertion order.
function dedupe(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}
