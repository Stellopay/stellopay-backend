import { selector } from "starknet";

const events = [
  "AgreementCreated",
  "AgreementActivated",
  "AgreementPaused",
  "AgreementResumed",
  "AgreementCancelled",
  "AgreementCompleted",
  "EmployeeAdded",
  "MilestoneAdded",
  "MilestoneApproved",
  "MilestoneClaimed",
  "PayrollClaimed",
  "DisputeRaised",
  "DisputeResolved",
  "PaymentSent",
  "PaymentReceived",
  "Funded",
  "Released",
  "Refunded",
];

const map = {};
events.forEach(e => {
  const selectorValue = selector.getSelectorFromName(e);
  map[selectorValue] = e;
});

console.log(JSON.stringify(map, null, 2));

