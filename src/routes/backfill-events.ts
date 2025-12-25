import { Router } from "express";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

export const backfillEventsRouter = Router();

// Backfill EmployeeAdded events from employees table
backfillEventsRouter.post("/backfill/employee-events", async (req, res, next) => {
  try {
    // Get all employees that don't have corresponding EmployeeAdded events
    const employeesWithoutEvents = await db.execute(sql`
      SELECT e.id, e.agreement_id, e.contract_address, e.block_number, 
             e.transaction_hash, e.created_at
      FROM employees e
      WHERE NOT EXISTS (
        SELECT 1 FROM agreement_events ae
        WHERE ae.agreement_id = e.agreement_id
        AND ae.event_type = 'EmployeeAdded'
        AND ae.transaction_hash = e.transaction_hash
      )
      ORDER BY e.created_at DESC
    `);

    let created = 0;
    const results = [];

    for (const employee of employeesWithoutEvents.rows) {
      try {
        // Create event ID from transaction hash and a unique identifier
        // Since we don't have eventIndex, we'll use a hash of employee id
        const eventId = `${employee.transaction_hash}_employee_${employee.id}`;
        
        // Check if event already exists
        const existing = await db
          .select()
          .from(schema.agreementEvents)
          .where(eq(schema.agreementEvents.id, eventId))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(schema.agreementEvents).values({
            id: eventId,
            agreementId: String(employee.agreement_id),
            contractAddress: String(employee.contract_address),
            eventType: "EmployeeAdded",
            blockNumber: Number(employee.block_number),
            transactionHash: String(employee.transaction_hash),
            eventIndex: 0, // We don't have the actual index, use 0
          });

          created++;
          results.push({
            employeeId: employee.id,
            agreementId: employee.agreement_id,
            status: "created",
          });
        }
      } catch (e) {
        results.push({
          employeeId: employee.id,
          status: "error",
          error: String(e),
        });
      }
    }

    res.json({
      message: `Backfilled ${created} EmployeeAdded events`,
      totalEmployees: employeesWithoutEvents.rows.length,
      created,
      results: results.slice(0, 10), // Show first 10 results
    });
  } catch (e) {
    next(e);
  }
});

// Backfill MilestoneAdded events from milestones table
backfillEventsRouter.post("/backfill/milestone-events", async (req, res, next) => {
  try {
    const milestonesWithoutEvents = await db.execute(sql`
      SELECT m.id, m.agreement_id, m.contract_address, m.block_number, 
             m.transaction_hash, m.created_at
      FROM milestones m
      WHERE NOT EXISTS (
        SELECT 1 FROM agreement_events ae
        WHERE ae.agreement_id = m.agreement_id
        AND ae.event_type = 'MilestoneAdded'
        AND ae.transaction_hash = m.transaction_hash
      )
      ORDER BY m.created_at DESC
    `);

    let created = 0;
    const results = [];

    for (const milestone of milestonesWithoutEvents.rows) {
      try {
        const eventId = `${milestone.transaction_hash}_milestone_${milestone.id}`;
        
        const existing = await db
          .select()
          .from(schema.agreementEvents)
          .where(eq(schema.agreementEvents.id, eventId))
          .limit(1);

        if (existing.length === 0) {
          await db.insert(schema.agreementEvents).values({
            id: eventId,
            agreementId: String(milestone.agreement_id),
            contractAddress: String(milestone.contract_address),
            eventType: "MilestoneAdded",
            blockNumber: Number(milestone.block_number),
            transactionHash: String(milestone.transaction_hash),
            eventIndex: 0,
          });

          created++;
          results.push({
            milestoneId: milestone.id,
            agreementId: milestone.agreement_id,
            status: "created",
          });
        }
      } catch (e) {
        results.push({
          milestoneId: milestone.id,
          status: "error",
          error: String(e),
        });
      }
    }

    res.json({
      message: `Backfilled ${created} MilestoneAdded events`,
      totalMilestones: milestonesWithoutEvents.rows.length,
      created,
      results: results.slice(0, 10),
    });
  } catch (e) {
    next(e);
  }
});

