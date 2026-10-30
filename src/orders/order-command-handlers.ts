import { PricingCatalog } from '../pricing/pricing-catalog';
import { UnknownTaxRegionError } from '../pricing/pricing-errors';
import { Clock, MINUTE_MS, toIsoString } from '../shared/clock';
import { CommandContext, HandlerMap, HandlerOutcome } from '../shared/commands/command';
import { IdGenerator } from '../shared/ids';
import { cents } from '../shared/money';
import { Order } from './order';
import { OrderCommand } from './order-commands';
import { OrderAlreadyExistsError } from './order-errors';
import { loadExistingOrder, OrderRepository } from './order-repository';

/** Unpaid orders hold their stock for this long after being placed. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * MINUTE_MS;

export interface OrderHandlerDependencies {
  readonly repository: OrderRepository;
  readonly catalog: PricingCatalog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly reservationTtlMs?: number;
}

export function orderCommandHandlers(dependencies: OrderHandlerDependencies): HandlerMap<OrderCommand> {
  const { repository, catalog, clock, ids } = dependencies;
  const reservationTtlMs = dependencies.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;

  const save = (order: Order, context: CommandContext): HandlerOutcome => {
    const events = repository.save(order, context.metadata);
    return { aggregateId: order.orderId, version: order.version, events };
  };

  const change = (orderId: string, context: CommandContext, act: (order: Order) => void): HandlerOutcome => {
    const order = loadExistingOrder(repository, orderId);
    act(order);
    return save(order, context);
  };

  return {
    CreateOrder: ({ payload }, context) => {
      if (repository.exists(payload.orderId)) {
        throw new OrderAlreadyExistsError(payload.orderId);
      }
      if (!catalog.taxRates.supports(payload.shippingRegion)) {
        throw new UnknownTaxRegionError(payload.shippingRegion);
      }
      const order = new Order(payload.orderId);
      order.create(payload.customerId, payload.shippingRegion);
      return save(order, context);
    },
    AddOrderLine: ({ payload }, context) =>
      change(payload.orderId, context, (order) =>
        order.addLine({
          lineId: payload.lineId ?? ids.next(),
          sku: payload.sku,
          quantity: payload.quantity,
          unitPriceCents: catalog.prices.priceOf(payload.sku),
        }),
      ),
    RemoveOrderLine: ({ payload }, context) =>
      change(payload.orderId, context, (order) => order.removeLine(payload.lineId)),
    ApplyDiscountCode: ({ payload }, context) =>
      change(payload.orderId, context, (order) => order.applyDiscountCode(catalog.discountCodes.lookup(payload.code))),
    ApplyCoupon: ({ payload }, context) =>
      change(payload.orderId, context, (order) => order.applyCoupon(catalog.coupons.lookup(payload.code))),
    PlaceOrder: ({ payload }, context) =>
      change(payload.orderId, context, (order) =>
        order.place(
          catalog.taxRates.rateFor(order.shippingRegion),
          toIsoString(clock.now() + reservationTtlMs),
        ),
      ),
    RecordOrderStockReserved: ({ payload }, context) =>
      change(payload.orderId, context, (order) => order.recordStockReserved()),
    MarkOrderPaid: ({ payload }, context) =>
      change(payload.orderId, context, (order) =>
        order.markPaid(payload.paymentId, cents(payload.amountCents), clock.now()),
      ),
    ShipOrder: ({ payload }, context) =>
      change(payload.orderId, context, (order) => order.ship(payload.trackingNumber)),
    DeliverOrder: ({ payload }, context) => change(payload.orderId, context, (order) => order.deliver()),
    CancelOrder: ({ payload }, context) => change(payload.orderId, context, (order) => order.cancel(payload.reason)),
    ExpireOrderReservation: ({ payload }, context) =>
      change(payload.orderId, context, (order) => order.expireReservation(clock.now())),
    RefundOrderLine: ({ payload }, context) =>
      change(payload.orderId, context, (order) =>
        order.refundLine(payload.refundId ?? ids.next(), payload.lineId, payload.quantity),
      ),
    CreditOrder: ({ payload }, context) =>
      change(payload.orderId, context, (order) =>
        order.credit(payload.creditId ?? ids.next(), payload.amountCents, payload.reason),
      ),
  };
}
