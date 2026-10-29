---
name: verify-stock-sale
description: "Prove a non-backorder SKU is never oversold, and a restock never invents a unit, across every order of reserve, release, sale, and restock. Use when editing markOrderPaid, reservationStatements, reservationStatementsSetBased, releaseOrderHoldsStmts, restockOrderStatements, or scripts/verify-stock-sale.mjs."
---

# Verify stock sale

A test checks the interleavings someone wrote down. This check walks every order of the stock steps inside a fixed bound.

**Property.** For a SKU that does not continue selling, holds never exceed what is on hand, reserved stock matches the active holds, and a restock never returns more units than were sold.

**Harm.** A customer pays for a unit that was already sold, or a replayed return invents stock and a later sale ships a unit the store does not have.

## When to run

Run it when a change touches any of these:

- `src/server/checkout.ts` `markOrderPaid`
- `src/server/inventory.ts` `reservationStatements`
- `src/server/inventory.ts` `reservationStatementsSetBased`
- `src/server/inventory.ts` `releaseOrderHoldsStmts`
- `src/server/inventory.ts` `restockOrderStatements`
- `scripts/verify-stock-sale.mjs`

From the `web` directory:

```
npm run verify:stock
```

That runs `node scripts/verify-stock-sale.mjs`. The script is the checker. It reads those functions and searches every order of the four steps. Exit 0 is a pass. Exit 1 is a broken property. Exit 2 means the checker could not find a covered function: that is a modeling error, not a stock bug.

## What the model counts as one step

Each step is one D1 batch, because that is one transaction in the code.

- Reserve is `reservationStatements` and `reservationStatementsSetBased`: `reserved` increases only when `on_hand - reserved` covers the quantity, or the variant continues selling.
- Release is `releaseOrderHoldsStmts`: ledger, `reserved`, and the reservation row all name `status='active'`.
- Sale is `markOrderPaid`: the order update's `NOT EXISTS` rejects the sale when a non-backorder line needs more than `on_hand - reserved` beyond that order's own active hold. Recovery top-up, the stock decrement, and the commit of active reservations are the same batch.
- Restock is `restockOrderStatements`: it adds `on_hand` for `status='committed'` rows and stamps `restocked_at` only while that column is null.

## Bounds and assumptions

The pass line prints the bound. The checker uses one SKU, `continue_selling` off, `on_hand` starting at 2, and four orders of quantity 1.

A pass does not cover:

- `continue_selling = 1`
- a line whose active hold is not exactly its quantity, or more than one line
- more than one SKU in a basket
- payment claims, capture, and refunds, which decide whether a sale or a release runs
- a crash inside a batch
- database CHECK triggers that reject a negative counter after the fact

The payment gate on `releaseReservationStmts` only removes releases. The model allows every release of an active hold, which is the larger set.

## How to read a failure

The numbered lines are the steps, in the code's words. The `end:` line is the stock after the last step.

- `source is missing a guard` means a covered function no longer has the check the model requires. The following steps are the oversell or the invented unit that the missing check allows. Put the check back, or, if the new code keeps the same promise by a different check, update the needle in `scripts/verify-stock-sale.mjs` and the list above, then rerun.
- `the protocol breaks the stock property` with every guard present means the current steps can reach a bad stock state. Report the steps. Do not weaken the property, delete a needle, or change the product code unless the user asks.

## Stay in step with the code

Covered files and functions are the list under "When to run", except this skill and the checker.

Last confirmed: `f5689118c596d706aa7ce5ef956db9ba068de077`. The product files at that commit match the model, and `npm run verify:stock` passed.

Move that commit forward only after you have read the covered functions at the new commit, confirmed each step above is still one batch with the same guard, updated the needles if a guard moved, rerun `npm run verify:stock`, and seen a pass. A pass with a missing guard is not a pass.
