/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Finds pending sales orders, auto-approves the small ones, and logs a follow-up task for the rest.
 * Everything below runs through the generated context; the only NetSuite specifics live in the models.
 */
import { createErpContext } from '../models/generated/context.gen';
import type { SalesOrder } from '../models/generated/SalesOrder.gen';

const AUTO_APPROVAL_LIMIT = 5000;

export function getInputData(): SalesOrder[] {
    const db = createErpContext({ tracking: false });
    return db.salesOrders.query()
        .where('status', '=', 'B')
        .orderByAsc('tranDate')
        .page(1, 500)
        .executeTyped();
}

export function map(context: { value: string; write(key: string, value: string): void }): void {
    const db = createErpContext();
    const snapshot = JSON.parse(context.value) as SalesOrder;
    const order = db.salesOrders.find(snapshot.id);
    if (!order) {
        return;
    }

    if (order.total < AUTO_APPROVAL_LIMIT && order.lines.every((line) => line.quantity > 0)) {
        order.autoApproved = true;
        order.memo = 'Auto-approved';
    } else {
        db.tasks.add({
            title: `Review order ${order.tranId}`,
            assignedTo: null,
            transactionId: order.id,
            dueDate: null,
            completed: false,
        } as never);
    }

    const result = db.saveChanges();
    context.write(String(order.id), result.success ? 'saved' : result.results.map((saved) => saved.result.error).join('; '));
}

export function summarize(summary: { output: { iterator(): { each(callback: (key: string, value: string) => boolean): void } } }): void {
    const db = createErpContext({ tracking: false });
    const recentlyApproved = db.salesOrders.asNoTracking()
        .exclude('customer', 'shippingAddress')
        .where('autoApproved', '=', true)
        .orderByDesc('tranDate')
        .limit(10)
        .executeTyped();

    summary.output.iterator().each((key, value) => {
        log.audit('order', `${key}: ${value}`);
        return true;
    });
    log.audit('recently approved', JSON.stringify(recentlyApproved.map((order) => ({ tranId: order.tranId, lineCount: order.lines.length }))));
}

declare const log: { audit(title: string, details: string): void };
