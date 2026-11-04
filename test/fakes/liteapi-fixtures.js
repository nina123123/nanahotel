/**
 * LiteAPI v3.0 response bodies shaped as src/live/liteapi.js expects them (see its VERIFY block), for fake fetch.
 * Fictional hotels and ids.
 */

export const SANDBOX_KEY = 'sand_c0ffee00-test-key-1234';

export const TIMES_SQUARE = { lat: 40.758, lng: -73.9855 };

export function hotelsList() {
  return {
    data: [
      {
        id: 'lp1a2b3', name: 'Midtown Lights Hotel', hotelDescription: '<p>Steps from <b>Times Square</b>.</p>', currency: 'USD', country: 'us',
        city: 'New York', latitude: 40.7590, longitude: -73.9845, address: '123 W 44th St', zip: '10036',
        main_photo: 'https://static.example-cdn.com/h/1.jpg', thumbnail: 'https://static.example-cdn.com/h/1t.jpg',
        stars: 4, rating: 8.6, reviewCount: 2412, chain: 'Not Available',
      },
      {
        id: 'lp4c5d6', name: 'Hudson Yard Inn', city: 'New York', latitude: 40.7540, longitude: -73.9990, address: '450 W 33rd St, New York',
        zip: '10001', main_photo: 'https://static.example-cdn.com/h/2.jpg', stars: 3, rating: 7.9, reviewCount: 980, chain: 'Example Stays',
      },
      {
        id: 'lp7e8f9', name: 'Brooklyn Bridge Suites', city: 'New York', latitude: 40.6990, longitude: -73.9920, address: '1 Front St',
        stars: 5, rating: 9.2, reviewCount: 410,
      },
      { id: 'lpdead0', name: 'Closed Hotel', city: 'New York', latitude: 40.7585, longitude: -73.9850, deletedAt: '2025-01-01T00:00:00Z' },
      { id: '', name: 'No id' },
    ],
  };
}

export function hotelDetails() {
  return {
    data: {
      id: 'lp1a2b3', name: 'Midtown Lights Hotel', hotelDescription: '<p>Steps from <b>Times Square</b>.&nbsp;Rooftop bar &amp; gym.</p>',
      checkinCheckoutTimes: { checkout: '11:00', checkin: '3:00 PM' },
      hotelImages: [
        { url: 'https://static.example-cdn.com/h/1-b.jpg', urlHd: 'https://static.example-cdn.com/h/1-b-hd.jpg', order: 2, defaultImage: false },
        { url: 'https://static.example-cdn.com/h/1-a.jpg', urlHd: 'https://static.example-cdn.com/h/1-a-hd.jpg', order: 5, defaultImage: true },
      ],
      main_photo: 'https://static.example-cdn.com/h/1.jpg',
      country: 'us', city: 'New York', starRating: 4, location: { latitude: 40.7590, longitude: -73.9845 }, address: '123 W 44th St', zip: '10036',
      hotelFacilities: ['Free WiFi', 'Fitness center', 'Free WiFi', 'Rooftop bar'], phone: '+12125550123', rating: 8.6, reviewCount: 2412,
      rooms: [
        { id: 555, roomName: 'Deluxe King', roomSizeSquare: 300, roomSizeUnit: 'sqft', maxOccupancy: 2, bedTypes: [{ quantity: 1, bedType: 'King' }], photos: [{ url: 'https://static.example-cdn.com/r/555.jpg', hd_url: 'https://static.example-cdn.com/r/555-hd.jpg' }] },
        { id: 556, roomName: 'Queen Room', roomSizeSquare: 22, roomSizeUnit: 'm2', maxOccupancy: 2, bedTypes: [{ quantity: 2, bedType: 'Queen' }] },
      ],
    },
  };
}

function rate({ name, board = 'RO', boardName = 'Room Only', total, refundable, cancelTime, penalty, mapped, excludedFee = 0, ssp }) {
  return {
    rateId: `raw-${name}-${board}-${total}`, occupancyNumber: 1, name, maxOccupancy: 2, adultCount: 2, childCount: 0, boardType: board, boardName,
    remarks: '', priceType: 'commission', commission: [{ amount: 20, currency: 'USD' }], mappedRoomId: mapped,
    retailRate: {
      total: [{ amount: total, currency: 'USD' }],
      suggestedSellingPrice: ssp ? [{ amount: ssp, currency: 'USD', source: 'providerDirect' }] : [],
      taxesAndFees: [{ included: true, description: 'Taxes', amount: 40, currency: 'USD' }, ...(excludedFee ? [{ included: false, description: 'Resort fee', amount: excludedFee, currency: 'USD' }] : [])],
    },
    cancellationPolicies: refundable
      ? { refundableTag: 'RFN', cancelPolicyInfos: [{ cancelTime, amount: penalty, currency: 'USD', type: 'amount', timezone: 'GMT' }], hotelRemarks: [] }
      : { refundableTag: 'NRFN', cancelPolicyInfos: [], hotelRemarks: [] },
    paymentTypes: ['NUITEE_PAY'],
  };
}

/** `suffix` changes every offerId (a later search of the same stay returns new offer ids). */
export function ratesResponse({ suffix = '' } = {}) {
  return {
    data: [
      {
        hotelId: 'lp1a2b3',
        roomTypes: [
          { roomTypeId: 'a', offerId: `OFFER-A-very-long-opaque-offer-id${suffix}`, supplier: 'S1', offerRetailRate: { amount: 412.3, currency: 'USD' }, rates: [rate({ name: 'Deluxe King', total: 412.3, refundable: false, mapped: 555, ssp: 450 })] },
          { roomTypeId: 'b', offerId: `OFFER-B${suffix}`, supplier: 'S1', offerRetailRate: { amount: 468, currency: 'USD' }, rates: [rate({ name: 'Deluxe King', board: 'BB', boardName: 'Breakfast Included', total: 468, refundable: true, cancelTime: '2026-12-02 23:59:59', penalty: 234, mapped: 555 })] },
          { roomTypeId: 'c', offerId: `OFFER-C-same-but-dearer${suffix}`, supplier: 'S2', offerRetailRate: { amount: 480, currency: 'USD' }, rates: [rate({ name: 'Deluxe King', board: 'BB', boardName: 'Breakfast Included', total: 480, refundable: true, cancelTime: '2026-12-02 23:59:59', penalty: 240, mapped: 555 })] },
          { roomTypeId: 'd', offerId: `OFFER-D${suffix}`, supplier: 'S1', offerRetailRate: { amount: 380, currency: 'USD' }, rates: [rate({ name: 'Queen Room', total: 380, refundable: true, cancelTime: '2026-12-03 12:00:00', penalty: 380, mapped: 556, excludedFee: 50 })] },
          { roomTypeId: 'e', offerId: '', rates: [] },
        ],
      },
      {
        hotelId: 'lp4c5d6',
        roomTypes: [
          { roomTypeId: 'x', offerId: `OFFER-X${suffix}`, offerRetailRate: { amount: 301.5, currency: 'USD' }, rates: [rate({ name: 'Standard Double', total: 301.5, refundable: false })] },
        ],
      },
    ],
  };
}

export function prebookResponse({ price = 468, pct = 0 } = {}) {
  return {
    data: {
      prebookId: 'pb_7f3a', offerId: 'OFFER-B', hotelId: 'lp1a2b3', currency: 'USD', price, priceDifferencePercent: pct,
      cancellationChanged: false, boardChanged: false, termsAndConditions: '<p>Hotel terms &amp; conditions.</p>',
      roomTypes: [{ rates: [rate({ name: 'Deluxe King', board: 'BB', boardName: 'Breakfast Included', total: price, refundable: true, cancelTime: '2026-12-02 23:59:59', penalty: 234, mapped: 555 })] }],
      transactionId: 'tr_9b2c', secretKey: 'pi_3Q_secret_test_abc',
      checkin: '2026-12-04', checkout: '2026-12-06',
    },
  };
}

export function bookResponse({ status = 'CONFIRMED' } = {}) {
  return {
    data: {
      bookingId: 'BKX7Q2', clientReference: 'HA20261104123456', supplierBookingId: 'SUP-1', supplierBookingName: 'S1', status,
      hotelConfirmationCode: 'MLH-77801', checkin: '2026-12-04', checkout: '2026-12-06',
      hotel: { hotelId: 'lp1a2b3', name: 'Midtown Lights Hotel' },
      bookedRooms: [{ roomType: { name: 'Deluxe King' }, adults: 2, children: 0, rate: { boardName: 'Breakfast Included' }, firstName: 'Sarah', lastName: 'Miller' }],
      holder: { firstName: 'Sarah', lastName: 'Miller', email: 'sarah@example.com' },
      createdAt: '2026-11-04T16:00:00Z', price: 468, currency: 'USD',
      cancellationPolicies: { refundableTag: 'RFN', cancelPolicyInfos: [{ cancelTime: '2026-12-02 23:59:59', amount: 234, currency: 'USD', timezone: 'GMT' }] },
    },
  };
}

export function cancelResponse() {
  return { data: { bookingId: 'BKX7Q2', status: 'CANCELLED', cancellation_fee: 0, refund_amount: 468, currency: 'USD' } };
}
