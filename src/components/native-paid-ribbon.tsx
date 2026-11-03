"use client";

import Decimal from "decimal.js";
import { billTotal } from "./api";
import type { Bill } from "./types";
import styles from "./native-paid-ribbon.module.css";

export function isNativeBillPaid(bill: Bill): boolean {
  if (!["READY", "APPROVED"].includes(bill.status) || bill.paymentStatus !== "PAID") return false;
  try {
    const total = new Decimal(String(billTotal(bill)));
    const paid = new Decimal(String(bill.paidAmount ?? "0"));
    if (!total.isFinite() || !total.gt(0) || !paid.isFinite() || !paid.eq(total)) return false;
  } catch {
    return false;
  }
  return true;
}

export function NativePaidRibbon({ bill }: { bill: Bill }) {
  if (!isNativeBillPaid(bill)) return null;
  return <span className={styles.corner} role="img" aria-label="Paid in full"><span aria-hidden="true">Paid</span></span>;
}
