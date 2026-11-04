/**
 * Demo cities for the simulated supplier: real neighborhoods and real landmarks with approximate WGS-84
 * coordinates (a few hundred feet of accuracy). Hotels generated around these areas are fictional; the places
 * themselves are not.
 *
 * City fields:
 *  zone        IANA time zone: times at the city's hotels (check-in, wake-up calls, rides) are in it
 *  areaCode    for fictional 555-01xx phone numbers
 *  market      'business' | 'mixed' | 'leisure': how holidays and weekends move prices (holidays.js, pricing.js)
 *  priceLevel  the city's price factor on the national bands (New York well above Orlando)
 *  tax         hotel taxes: `rate` on the room (and resort fee), `perNight` flat fees
 *  weekdays    nightly price factors Sunday … Saturday (leisure cities peak on weekends, business ones midweek)
 *  season      12 monthly price factors
 * Area fields:
 *  kind      drives the generated hotel mix (see sim-hotels.js)
 *  spreadM   how far generated hotels sit from the area center
 *  bearings  [from, to] degrees clockwise from north where hotels may be placed (keeps them out of the ocean,
 *            lakes, rivers, parks and runways); may exceed 360 to wrap around north
 *  features  tags/amenity hints: subway (rail transit) lake river sea bay park skyline mountain family night quiet
 *            oldtown station airport resortfee (hotels add a daily resort fee)
 * Landmark extentM: distances to big places (Central Park, a beach, an airport) are measured from roughly their edge.
 * Landmark district: only when it differs from its area's district.
 */

/** extentM: rough radius of an extended place (park, beach, airport), so distances are measured from its edge. */
function L(name, type, lng, lat, aliases = [], extentM = 0, district) {
  return { name, type, location: { lng, lat }, aliases, extentM, ...(district ? { district } : {}) };
}

function A(name, district, kind, [lng, lat], { aliases = [], short, spreadM, bearings, features = [], reason, landmarks }) {
  return { name, aliases, short: short || name.split(/ \/ /)[0], district, kind, center: { lng, lat }, spreadM, bearings, features, reason, landmarks };
}

const RAW_CITIES = [
  {
    code: 'nyc', name: 'New York', state: 'NY', aliases: ['new york city', 'nyc', 'ny', 'manhattan', 'the big apple', 'big apple'],
    zone: 'America/New_York', areaCode: '212', market: 'mixed', priceLevel: 1.35, tax: { rate: 0.1475, perNight: 3.5 },
    weekdays: [0.95, 1, 1.05, 1.05, 1.05, 1.1, 1.15], season: [0.75, 0.75, 0.85, 0.95, 1, 1, 0.95, 0.95, 1.05, 1.1, 1.1, 1.2],
    center: [-73.9840, 40.7549],
    areas: [
      A('Times Square / Midtown', 'Midtown Manhattan', 'scenic', [-73.9855, 40.7580], {
        aliases: ['Times Square', 'Midtown', 'Theater District', 'Theatre District', 'Broadway', 'Midtown Manhattan'], short: 'Times Square',
        spreadM: 1100, features: ['subway', 'night', 'skyline'],
        reason: 'In the middle of everything: Broadway shows, Rockefeller Center and the subway at your door. Busy and bright around the clock.',
        landmarks: [
          L('Times Square', 'Sight', -73.9855, 40.7580, ['times sq', 'crossroads of the world']),
          L('Broadway Theater District', 'Nightlife', -73.9861, 40.7590, ['theater district', 'theatre district', 'broadway shows', 'broadway theaters']),
          L('Rockefeller Center', 'Sight', -73.9787, 40.7587, ['rockefeller', 'top of the rock', '30 rock', 'rockefeller plaza']),
          L('Bryant Park', 'Park', -73.9832, 40.7536, []),
          L('Grand Central Terminal', 'Transit hub', -73.9772, 40.7527, ['grand central', 'grand central station']),
          L('Empire State Building', 'Sight', -73.9857, 40.7484, ['empire state']),
        ],
      }),
      A("Hell's Kitchen / Midtown West", "Hell's Kitchen", 'nightlife', [-73.9910, 40.7620], {
        aliases: ["Hell's Kitchen", 'Hells Kitchen', 'Midtown West', 'Clinton', 'Hudson Yards'], short: "Hell's Kitchen",
        spreadM: 900, features: ['subway', 'night'],
        reason: "Restaurant Row and the theaters a few blocks east, with better prices than Times Square itself.",
        landmarks: [
          L('Restaurant Row', 'Food & drink', -73.9883, 40.7601, ['west 46th street', 'ninth avenue restaurants']),
          L('Intrepid Museum', 'Museum', -73.9996, 40.7645, ['intrepid', 'intrepid sea air & space museum']),
          L('Hudson Yards', 'Shopping', -74.0020, 40.7538, ['the vessel', 'vessel', 'the edge'], 0, 'Hudson Yards'),
          L('Penn Station', 'Transit hub', -73.9935, 40.7506, ['pennsylvania station', 'madison square garden', 'msg', 'moynihan train hall'], 0, 'Midtown Manhattan'),
        ],
      }),
      A('Central Park', 'Upper West Side', 'scenic', [-73.9819, 40.7681], {
        aliases: ['Central Park South', 'Upper West Side', 'Columbus Circle', 'Lincoln Center'], short: 'Central Park',
        bearings: [180, 380], spreadM: 1200, features: ['subway', 'park', 'quiet'],
        reason: 'Leafy and calmer: steps from Central Park, Lincoln Center and the big museums, with the subway close by.',
        landmarks: [
          L('Central Park', 'Park', -73.9654, 40.7829, ['the park', 'central park zoo', 'bethesda fountain', 'strawberry fields'], 1800),
          L('The Metropolitan Museum of Art', 'Museum', -73.9632, 40.7794, ['the met', 'met museum', 'metropolitan museum'], 0, 'Upper East Side'),
          L('American Museum of Natural History', 'Museum', -73.9740, 40.7813, ['natural history museum', 'amnh']),
          L('Columbus Circle', 'Landmark', -73.9819, 40.7681, []),
          L('Lincoln Center', 'Sight', -73.9835, 40.7725, ['lincoln center for the performing arts', 'metropolitan opera', 'the met opera']),
          L('Carnegie Hall', 'Sight', -73.9799, 40.7651, [], 0, 'Midtown Manhattan'),
        ],
      }),
      A('SoHo / Greenwich Village', 'Lower Manhattan', 'shopping', [-74.0010, 40.7250], {
        aliases: ['SoHo', 'Greenwich Village', 'the Village', 'West Village', 'Tribeca', 'Nolita'], short: 'SoHo',
        bearings: [330, 590], spreadM: 900, features: ['subway', 'night'],
        reason: 'Cast-iron streets full of boutiques, galleries and great restaurants; the Village is a short walk away.',
        landmarks: [
          L('SoHo', 'Shopping', -74.0030, 40.7233, ['soho shopping', 'prince street', 'spring street']),
          L('Washington Square Park', 'Park', -73.9973, 40.7308, ['washington square', 'nyu']),
          L('Little Italy', 'Food & drink', -73.9973, 40.7191, ['mulberry street']),
          L('Chinatown', 'Food & drink', -73.9970, 40.7158, ['manhattan chinatown', 'canal street']),
          L('The High Line', 'Park', -74.0048, 40.7480, ['high line', 'chelsea market'], 0, 'Chelsea'),
        ],
      }),
      A('Financial District', 'Lower Manhattan', 'cbd', [-74.0090, 40.7075], {
        aliases: ['FiDi', 'Wall Street', 'Lower Manhattan', 'Downtown Manhattan', 'Battery Park City'], short: 'Wall Street',
        bearings: [300, 410], spreadM: 700, features: ['subway', 'river', 'skyline'],
        reason: 'Quiet at night and good value on weekends; the 9/11 Memorial, the Statue of Liberty ferries and the Brooklyn Bridge are all close.',
        landmarks: [
          L('Wall Street', 'Landmark', -74.0090, 40.7060, ['new york stock exchange', 'nyse', 'charging bull']),
          L('One World Trade Center', 'Sight', -74.0134, 40.7127, ['one world observatory', 'freedom tower', 'world trade center', 'wtc']),
          L('9/11 Memorial & Museum', 'Museum', -74.0134, 40.7115, ['911 memorial', '9/11 memorial', 'september 11 memorial', 'ground zero']),
          L('Battery Park', 'Park', -74.0170, 40.7033, ['statue of liberty', 'statue of liberty ferry', 'ellis island', 'staten island ferry', 'the battery']),
          L('Brooklyn Bridge', 'Sight', -73.9969, 40.7061, ['brooklyn bridge walk']),
          L('South Street Seaport', 'Shopping', -74.0036, 40.7065, ['seaport', 'pier 17']),
        ],
      }),
      A('Brooklyn', 'Brooklyn', 'nightlife', [-73.9850, 40.6990], {
        aliases: ['DUMBO', 'Downtown Brooklyn', 'Brooklyn Heights', 'Williamsburg'], short: 'Brooklyn',
        bearings: [60, 240], spreadM: 1500, features: ['subway', 'night', 'skyline'],
        reason: 'Manhattan skyline views, a lively food and bar scene and lower prices, one or two subway stops from Downtown.',
        landmarks: [
          L('DUMBO', 'Sight', -73.9881, 40.7033, ['dumbo brooklyn', 'manhattan bridge view']),
          L('Brooklyn Bridge Park', 'Park', -73.9967, 40.7003, ['brooklyn heights promenade']),
          L('Barclays Center', 'Stadium', -73.9754, 40.6826, []),
          L('Williamsburg', 'Nightlife', -73.9571, 40.7081, ['williamsburg brooklyn', 'bedford avenue']),
          L('Prospect Park', 'Park', -73.9690, 40.6602, [], 800),
        ],
      }),
      A('JFK Airport', 'Queens', 'airport', [-73.7900, 40.6680], {
        aliases: ['JFK', 'Kennedy Airport', 'Jamaica', 'Queens'], short: 'JFK Airport',
        bearings: [270, 450], spreadM: 2000, features: ['airport'],
        reason: 'For a red-eye or an early flight: free shuttles to the terminals, but an hour from Manhattan.',
        landmarks: [L('John F. Kennedy International Airport', 'Transit hub', -73.7781, 40.6413, ['jfk', 'jfk airport', 'kennedy airport', 'jfk international', 'jfk terminal 4'], 1500)],
      }),
    ],
  },
  {
    code: 'la', name: 'Los Angeles', state: 'CA', aliases: ['la', 'l.a.', 'los angeles county'],
    zone: 'America/Los_Angeles', areaCode: '213', market: 'mixed', priceLevel: 1.1, tax: { rate: 0.155, perNight: 0 },
    weekdays: [0.95, 1, 1, 1, 1, 1.1, 1.15], season: [0.95, 0.95, 1, 1, 1, 1.1, 1.15, 1.15, 1, 1, 0.95, 0.95],
    center: [-118.2437, 34.0522],
    areas: [
      A('Hollywood', 'Hollywood', 'scenic', [-118.3267, 34.1016], {
        aliases: ['Hollywood Boulevard', 'Walk of Fame', 'Hollywood Hills'], short: 'Hollywood',
        spreadM: 1300, features: ['subway', 'night'],
        reason: 'The Walk of Fame, the Hollywood Bowl and the Metro to Downtown; touristy but fun.',
        landmarks: [
          L('Hollywood Walk of Fame', 'Sight', -118.3267, 34.1016, ['walk of fame', 'hollywood boulevard', 'hollywood blvd']),
          L('TCL Chinese Theatre', 'Sight', -118.3409, 34.1022, ['chinese theatre', "grauman's chinese theatre"]),
          L('Hollywood Sign', 'Sight', -118.3215, 34.1341, ['the hollywood sign']),
          L('Hollywood Bowl', 'Sight', -118.3391, 34.1122, []),
          L('Griffith Observatory', 'Sight', -118.3004, 34.1184, ['griffith park']),
          L('Universal Studios Hollywood', 'Theme park', -118.3534, 34.1381, ['universal studios', 'universal hollywood', 'universal'], 600, 'Universal City'),
        ],
      }),
      A('Santa Monica', 'Santa Monica', 'beach', [-118.4930, 34.0150], {
        aliases: ['Santa Monica Beach', 'Venice', 'Venice Beach'], short: 'Santa Monica',
        bearings: [320, 490], spreadM: 1200, features: ['sea', 'family', 'quiet'],
        reason: 'Beach mornings, the pier and the Third Street Promenade; walk or bike to Venice.',
        landmarks: [
          L('Santa Monica Pier', 'Sight', -118.4973, 34.0094, ['the pier', 'pacific park']),
          L('Third Street Promenade', 'Shopping', -118.4966, 34.0162, ['3rd street promenade', 'the promenade']),
          L('Santa Monica State Beach', 'Beach', -118.4962, 34.0105, ['santa monica beach'], 800),
          L('Venice Beach Boardwalk', 'Beach', -118.4695, 33.9850, ['venice beach', 'venice boardwalk', 'muscle beach'], 0, 'Venice'),
        ],
      }),
      A('Downtown LA', 'Downtown', 'cbd', [-118.2550, 34.0480], {
        aliases: ['DTLA', 'Downtown Los Angeles', 'Downtown', 'LA Live'], short: 'Downtown LA',
        spreadM: 1200, features: ['subway', 'night', 'skyline'],
        reason: 'Concert halls, the arena and the convention center, rooftop bars, and Metro lines in every direction.',
        landmarks: [
          L('Crypto.com Arena', 'Stadium', -118.2673, 34.0430, ['staples center', 'la live', 'l.a. live']),
          L('Walt Disney Concert Hall', 'Sight', -118.2498, 34.0553, ['disney concert hall']),
          L('The Broad', 'Museum', -118.2501, 34.0544, ['broad museum']),
          L('Los Angeles Union Station', 'Transit hub', -118.2365, 34.0562, ['union station', 'la union station']),
          L('Grand Central Market', 'Food & drink', -118.2489, 34.0508, []),
          L('Los Angeles Convention Center', 'Convention center', -118.2696, 34.0403, ['la convention center', 'lacc', 'convention center']),
        ],
      }),
      A('Beverly Hills', 'Beverly Hills', 'shopping', [-118.4004, 34.0700], {
        aliases: ['Rodeo Drive', 'Century City', 'West Hollywood'], short: 'Beverly Hills',
        spreadM: 1200, features: ['quiet'],
        reason: 'Rodeo Drive, palm-lined streets and polished hotels; quiet and central to the Westside.',
        landmarks: [
          L('Rodeo Drive', 'Shopping', -118.4006, 34.0679, ['rodeo dr']),
          L('Beverly Gardens Park', 'Park', -118.4004, 34.0736, ['beverly hills sign']),
          L('Getty Center', 'Museum', -118.4741, 34.0780, ['the getty'], 0, 'Brentwood'),
        ],
      }),
      A('LAX', 'Westchester', 'airport', [-118.3870, 33.9455], {
        aliases: ['LAX Airport', 'Century Boulevard', 'El Segundo'], short: 'LAX',
        bearings: [330, 560], spreadM: 1800, features: ['airport'],
        reason: 'Hotel row on Century Boulevard with shuttles every few minutes; easy for an early flight.',
        landmarks: [L('Los Angeles International Airport', 'Transit hub', -118.4085, 33.9416, ['lax', 'lax airport', 'tom bradley international terminal', 'los angeles airport'], 1500)],
      }),
    ],
  },
  {
    code: 'sf', name: 'San Francisco', state: 'CA', aliases: ['sf', 's.f.', 'san fran', 'frisco'],
    zone: 'America/Los_Angeles', areaCode: '415', market: 'business', priceLevel: 1.15, tax: { rate: 0.16, perNight: 0 },
    weekdays: [0.9, 1, 1.08, 1.08, 1.05, 0.95, 1], season: [0.85, 0.9, 0.95, 1, 1, 1.05, 1.05, 1.05, 1.1, 1.15, 0.95, 0.85],
    center: [-122.4194, 37.7749],
    areas: [
      A('Union Square', 'Union Square', 'shopping', [-122.4075, 37.7880], {
        aliases: ['Downtown San Francisco', 'Nob Hill', 'SoMa', 'Moscone'], short: 'Union Square',
        spreadM: 900, features: ['subway', 'night'],
        reason: 'Shopping, theaters and cable cars at the doorstep; BART and Muni make it the easiest base.',
        landmarks: [
          L('Union Square', 'Shopping', -122.4075, 37.7880, []),
          L('Powell Street Cable Car Turnaround', 'Transit hub', -122.4078, 37.7848, ['cable car', 'cable cars', 'powell street', 'powell and market']),
          L('Chinatown Dragon Gate', 'Sight', -122.4056, 37.7907, ['chinatown', 'dragon gate', 'grant avenue']),
          L('Moscone Center', 'Convention center', -122.4016, 37.7842, ['moscone', 'convention center']),
          L('SFMOMA', 'Museum', -122.4011, 37.7857, ['san francisco museum of modern art', 'museum of modern art']),
        ],
      }),
      A("Fisherman's Wharf", "Fisherman's Wharf", 'scenic', [-122.4170, 37.8060], {
        aliases: ['Fishermans Wharf', 'the Wharf', 'North Beach', 'Pier 39'], short: "Fisherman's Wharf",
        bearings: [90, 270], spreadM: 700, features: ['bay', 'family'],
        reason: 'Sea lions at Pier 39, ferries to Alcatraz and Golden Gate views; touristy and great with kids.',
        landmarks: [
          L("Fisherman's Wharf", 'Sight', -122.4177, 37.8080, ['fishermans wharf', 'the wharf']),
          L('Pier 39', 'Sight', -122.4098, 37.8087, ['sea lions']),
          L('Ghirardelli Square', 'Shopping', -122.4229, 37.8059, ['ghirardelli']),
          L('Alcatraz ferry (Pier 33)', 'Transit hub', -122.4055, 37.8076, ['alcatraz', 'alcatraz island', 'pier 33']),
          L('Lombard Street', 'Sight', -122.4187, 37.8021, ['crooked street', 'lombard']),
          L('Golden Gate Bridge', 'Sight', -122.4783, 37.8199, ['golden gate'], 0, 'Presidio'),
        ],
      }),
      A('Financial District', 'Financial District', 'cbd', [-122.4010, 37.7930], {
        aliases: ['FiDi', 'Embarcadero', 'Ferry Building'], short: 'Embarcadero',
        bearings: [180, 360], spreadM: 700, features: ['subway', 'bay', 'skyline'],
        reason: 'Bay views, the Ferry Building market and BART under your feet; quiet on weekends.',
        landmarks: [
          L('Ferry Building', 'Food & drink', -122.3937, 37.7955, ['ferry building marketplace', 'ferry plaza']),
          L('Transamerica Pyramid', 'Landmark', -122.4028, 37.7952, ['the pyramid']),
          L('The Embarcadero', 'Sight', -122.3977, 37.7993, ['embarcadero', 'exploratorium']),
          L('Oracle Park', 'Stadium', -122.3893, 37.7786, ['giants ballpark', 'ballpark'], 0, 'SoMa'),
        ],
      }),
      A('SFO', 'Burlingame', 'airport', [-122.3850, 37.5950], {
        aliases: ['SFO Airport', 'Burlingame', 'Millbrae', 'San Francisco Airport'], short: 'SFO',
        bearings: [180, 360], spreadM: 1800, features: ['airport'],
        reason: 'Bayside hotels with airport shuttles; BART from Millbrae gets you downtown in about 30 minutes.',
        landmarks: [L('San Francisco International Airport', 'Transit hub', -122.3790, 37.6213, ['sfo', 'sfo airport', 'sf airport'], 1500)],
      }),
    ],
  },
  {
    code: 'lv', name: 'Las Vegas', state: 'NV', aliases: ['vegas', 'lv', 'sin city'],
    zone: 'America/Los_Angeles', areaCode: '702', market: 'leisure', priceLevel: 0.7, tax: { rate: 0.1338, perNight: 0 },
    weekdays: [1, 0.92, 0.92, 0.95, 1, 1.55, 1.7], season: [0.9, 1, 1.1, 1.1, 1.05, 0.9, 0.85, 0.85, 1, 1.05, 1, 0.95],
    center: [-115.1728, 36.1147],
    areas: [
      A('The Strip', 'Las Vegas Strip', 'resort', [-115.1728, 36.1147], {
        aliases: ['Strip', 'Las Vegas Strip', 'Vegas Strip', 'Las Vegas Boulevard', 'Center Strip'], short: 'The Strip',
        spreadM: 2200, features: ['night', 'resortfee'],
        reason: 'Casinos, shows and pools on one long boulevard, lively all night. Most hotels add a daily resort fee, already in our prices.',
        landmarks: [
          L('Las Vegas Strip', 'Sight', -115.1728, 36.1147, ['the strip', 'strip', 'las vegas boulevard', 'vegas strip'], 2000),
          L('Sphere', 'Sight', -115.1617, 36.1210, ['the sphere', 'las vegas sphere']),
          L('High Roller', 'Sight', -115.1681, 36.1176, ['high roller wheel', 'observation wheel']),
          L('Welcome to Fabulous Las Vegas sign', 'Sight', -115.1728, 36.0820, ['las vegas sign', 'welcome sign', 'vegas sign']),
          L('T-Mobile Arena', 'Stadium', -115.1784, 36.1029, []),
          L('Allegiant Stadium', 'Stadium', -115.1833, 36.0909, []),
        ],
      }),
      A('Convention Center', 'Paradise', 'cbd', [-115.1530, 36.1320], {
        aliases: ['LVCC', 'Las Vegas Convention Center', 'Paradise Road', 'UNLV'], short: 'Convention Center',
        spreadM: 1200, features: ['resortfee'],
        reason: 'Next to the convention halls, a quieter step off the Strip; handy for trade shows.',
        landmarks: [
          L('Las Vegas Convention Center', 'Convention center', -115.1520, 36.1316, ['lvcc', 'convention center', 'ces']),
          L('University of Nevada, Las Vegas', 'University', -115.1430, 36.1083, ['unlv']),
        ],
      }),
      A('Downtown / Fremont Street', 'Downtown', 'oldtown', [-115.1424, 36.1699], {
        aliases: ['Downtown Las Vegas', 'Downtown', 'Fremont Street', 'Fremont', 'Old Vegas'], short: 'Fremont Street',
        spreadM: 900, features: ['night', 'resortfee'],
        reason: 'Old Vegas: the Fremont Street light canopy, cheaper tables and rooms, and a growing arts district.',
        landmarks: [
          L('Fremont Street Experience', 'Sight', -115.1430, 36.1707, ['fremont street', 'fremont', 'viva vision']),
          L('The Mob Museum', 'Museum', -115.1411, 36.1728, ['mob museum']),
          L('Las Vegas Arts District', 'Nightlife', -115.1527, 36.1584, ['arts district', '18b']),
        ],
      }),
      A('Airport', 'Paradise', 'airport', [-115.1400, 36.0975], {
        aliases: ['Las Vegas Airport', 'Harry Reid Airport'], short: 'Vegas Airport',
        bearings: [270, 450], spreadM: 1500, features: ['airport'],
        reason: 'Close to the terminals and a short ride to the Strip; good for late arrivals.',
        landmarks: [L('Harry Reid International Airport', 'Transit hub', -115.1537, 36.0840, ['las vegas airport', 'mccarran', 'harry reid airport', 'vegas airport', 'las'], 1500)],
      }),
    ],
  },
  {
    code: 'mia', name: 'Miami', state: 'FL', aliases: ['mia', 'magic city'],
    zone: 'America/New_York', areaCode: '305', market: 'leisure', priceLevel: 1.15, tax: { rate: 0.14, perNight: 0 },
    weekdays: [0.95, 0.95, 0.95, 0.95, 1, 1.25, 1.35], season: [1.3, 1.35, 1.35, 1.15, 0.95, 0.85, 0.85, 0.8, 0.8, 0.9, 1, 1.2],
    center: [-80.1918, 25.7617],
    areas: [
      A('South Beach', 'Miami Beach', 'beach', [-80.1320, 25.7790], {
        aliases: ['SoBe', 'Miami Beach', 'Ocean Drive', 'Art Deco District'], short: 'South Beach',
        bearings: [350, 370], spreadM: 1800, features: ['sea', 'night', 'resortfee'],
        reason: 'Art Deco hotels steps from the sand, Ocean Drive and Lincoln Road; lively at night.',
        landmarks: [
          L('South Beach', 'Beach', -80.1300, 25.7826, ['south beach miami', 'sobe', 'miami beach', 'lummus park'], 1000),
          L('Ocean Drive', 'Nightlife', -80.1300, 25.7810, []),
          L('Art Deco Historic District', 'Sight', -80.1310, 25.7800, ['art deco district', 'art deco']),
          L('Lincoln Road', 'Shopping', -80.1390, 25.7906, ['lincoln road mall']),
          L('South Pointe Park', 'Park', -80.1340, 25.7680, ['south pointe pier']),
        ],
      }),
      A('Brickell / Downtown', 'Brickell', 'cbd', [-80.1920, 25.7680], {
        aliases: ['Brickell', 'Downtown Miami', 'Downtown', 'Bayfront'], short: 'Brickell',
        bearings: [180, 360], spreadM: 1100, features: ['subway', 'bay', 'night', 'skyline'],
        reason: 'Bay-view towers, rooftop bars and the free Metromover; close to the cruise port.',
        landmarks: [
          L('Brickell City Centre', 'Shopping', -80.1932, 25.7667, ['brickell']),
          L('Bayfront Park', 'Park', -80.1857, 25.7753, []),
          L('Bayside Marketplace', 'Shopping', -80.1866, 25.7783, ['bayside']),
          L('Pérez Art Museum Miami', 'Museum', -80.1866, 25.7859, ['perez art museum', 'pamm']),
          L('PortMiami', 'Transit hub', -80.1794, 25.7781, ['port of miami', 'cruise port', 'cruise terminal', 'miami cruise port']),
        ],
      }),
      A('Wynwood', 'Wynwood', 'nightlife', [-80.1994, 25.8010], {
        aliases: ['Design District', 'Midtown Miami'], short: 'Wynwood',
        spreadM: 900, features: ['night'],
        reason: 'Street art, breweries and galleries; younger and cheaper, ten minutes from the beach by car.',
        landmarks: [
          L('Wynwood Walls', 'Sight', -80.1994, 25.8010, ['wynwood', 'wynwood art district']),
          L('Miami Design District', 'Shopping', -80.1925, 25.8130, ['design district']),
        ],
      }),
      A('Miami Airport', 'Blue Lagoon', 'airport', [-80.2780, 25.7860], {
        aliases: ['Miami International', 'MIA Airport'], short: 'Miami Airport',
        bearings: [60, 200], spreadM: 1500, features: ['airport'],
        reason: 'Right by the terminals with free shuttles; good before a flight or a cruise transfer.',
        landmarks: [L('Miami International Airport', 'Transit hub', -80.2870, 25.7959, ['miami airport', 'mia airport'], 1500)],
      }),
    ],
  },
  {
    code: 'orl', name: 'Orlando', state: 'FL', aliases: ['orl', 'the city beautiful'],
    zone: 'America/New_York', areaCode: '407', market: 'leisure', priceLevel: 0.8, tax: { rate: 0.125, perNight: 0 },
    weekdays: [1, 0.95, 0.95, 0.95, 1, 1.15, 1.2], season: [0.95, 1, 1.2, 1.15, 0.95, 1.05, 1.1, 0.95, 0.8, 0.9, 0.95, 1.15],
    center: [-81.3789, 28.5384],
    areas: [
      A('Walt Disney World / Lake Buena Vista', 'Lake Buena Vista', 'resort', [-81.5100, 28.3800], {
        aliases: ['Disney', 'Disney World', 'Walt Disney World', 'Lake Buena Vista', 'Disney Springs'], short: 'Lake Buena Vista',
        spreadM: 2200, features: ['family'],
        reason: 'Minutes from the parks with shuttles and big pools; ideal with kids and quiet at night.',
        landmarks: [
          L('Walt Disney World Resort', 'Theme park', -81.5639, 28.3852, ['disney world', 'walt disney world', 'disney', 'wdw', 'disney parks'], 3000),
          L('Magic Kingdom', 'Theme park', -81.5812, 28.4177, ['magic kingdom park', 'cinderella castle'], 500),
          L('EPCOT', 'Theme park', -81.5494, 28.3747, ['epcot center'], 600),
          L('Disney Springs', 'Shopping', -81.5196, 28.3700, ['downtown disney']),
          L("Disney's Hollywood Studios", 'Theme park', -81.5598, 28.3575, ['hollywood studios'], 400),
          L("Disney's Animal Kingdom", 'Theme park', -81.5902, 28.3553, ['animal kingdom'], 600),
        ],
      }),
      A('Universal / International Drive', 'International Drive', 'resort', [-81.4690, 28.4550], {
        aliases: ['Universal', 'Universal Orlando', 'International Drive', 'I-Drive', 'Convention Center'], short: 'International Drive',
        spreadM: 2000, features: ['family', 'night'],
        reason: 'Walk or shuttle to Universal, restaurants all along I-Drive, and the convention center next door.',
        landmarks: [
          L('Universal Orlando Resort', 'Theme park', -81.4675, 28.4747, ['universal', 'universal studios', 'universal orlando', 'islands of adventure'], 900),
          L('Universal Epic Universe', 'Theme park', -81.4510, 28.4380, ['epic universe'], 500),
          L('ICON Park', 'Sight', -81.4687, 28.4433, ['the wheel', 'icon park orlando']),
          L('Orange County Convention Center', 'Convention center', -81.4687, 28.4246, ['occc', 'orlando convention center', 'convention center']),
          L('SeaWorld Orlando', 'Theme park', -81.4618, 28.4114, ['seaworld'], 500),
        ],
      }),
      A('Downtown Orlando', 'Downtown', 'cbd', [-81.3790, 28.5410], {
        aliases: ['Downtown', 'Lake Eola'], short: 'Downtown Orlando',
        spreadM: 900, features: ['lake', 'night'],
        reason: 'Lake Eola, the performing arts center and local restaurants; a real city feel, 25 minutes from the parks.',
        landmarks: [
          L('Lake Eola Park', 'Park', -81.3730, 28.5434, ['lake eola'], 250),
          L('Dr. Phillips Center for the Performing Arts', 'Sight', -81.3770, 28.5384, ['dr phillips center']),
          L('Kia Center', 'Stadium', -81.3839, 28.5392, ['amway center', 'magic game']),
        ],
      }),
      A('Orlando Airport', 'Airport', 'airport', [-81.3080, 28.4580], {
        aliases: ['MCO', 'Orlando International'], short: 'Orlando Airport',
        bearings: [270, 450], spreadM: 1500, features: ['airport'],
        reason: 'Easy for early flights: free airport shuttles and 20 minutes to I-Drive.',
        landmarks: [L('Orlando International Airport', 'Transit hub', -81.3081, 28.4312, ['mco', 'orlando airport', 'mco airport'], 1500)],
      }),
    ],
  },
  {
    code: 'chi', name: 'Chicago', state: 'IL', aliases: ['chi-town', 'chitown', 'the windy city', 'windy city', 'chi'],
    zone: 'America/Chicago', areaCode: '312', market: 'business', priceLevel: 0.95, tax: { rate: 0.1749, perNight: 0 },
    weekdays: [0.9, 1, 1.08, 1.08, 1.05, 0.95, 1], season: [0.7, 0.75, 0.85, 0.95, 1.05, 1.2, 1.2, 1.15, 1.1, 1, 0.85, 0.8],
    center: [-87.6298, 41.8781],
    areas: [
      A('Magnificent Mile', 'Near North Side', 'shopping', [-87.6244, 41.8950], {
        aliases: ['Mag Mile', 'Michigan Avenue', 'River North', 'Streeterville', 'Gold Coast'], short: 'Magnificent Mile',
        bearings: [180, 370], spreadM: 900, features: ['subway', 'night', 'lake'],
        reason: 'Shopping on Michigan Avenue, Navy Pier and the lakefront a short walk away, and great restaurants in River North.',
        landmarks: [
          L('Magnificent Mile', 'Shopping', -87.6244, 41.8948, ['mag mile', 'michigan avenue', 'michigan ave']),
          L('Navy Pier', 'Sight', -87.6086, 41.8917, []),
          L('Chicago Water Tower', 'Landmark', -87.6244, 41.8972, ['water tower', 'water tower place']),
          L('360 Chicago Observation Deck', 'Sight', -87.6229, 41.8988, ['hancock building', '875 north michigan', 'tilt']),
          L('Oak Street Beach', 'Beach', -87.6234, 41.9030, ['oak street']),
        ],
      }),
      A('The Loop', 'The Loop', 'cbd', [-87.6300, 41.8820], {
        aliases: ['Loop', 'Downtown Chicago', 'Downtown', 'Millennium Park'], short: 'The Loop',
        bearings: [170, 370], spreadM: 900, features: ['subway', 'night', 'river', 'skyline'],
        reason: 'Millennium Park, the Art Institute and the Riverwalk; the L stops at every corner.',
        landmarks: [
          L('Millennium Park', 'Park', -87.6226, 41.8826, [], 300),
          L('Cloud Gate', 'Sight', -87.6233, 41.8827, ['the bean', 'bean']),
          L('Art Institute of Chicago', 'Museum', -87.6237, 41.8796, ['art institute']),
          L('Willis Tower', 'Sight', -87.6359, 41.8789, ['sears tower', 'skydeck', 'the ledge']),
          L('Chicago Riverwalk', 'Sight', -87.6270, 41.8881, ['riverwalk', 'architecture boat tour', 'chicago river']),
          L('Chicago Union Station', 'Transit hub', -87.6403, 41.8786, ['union station', 'amtrak chicago']),
        ],
      }),
      A('South Loop / Museum Campus', 'South Loop', 'scenic', [-87.6250, 41.8670], {
        aliases: ['South Loop', 'Museum Campus', 'Grant Park', 'Soldier Field', 'McCormick Place'], short: 'South Loop',
        bearings: [180, 360], spreadM: 900, features: ['lake', 'family'],
        reason: 'Walk to the Field Museum, Shedd Aquarium and Soldier Field; handy for McCormick Place.',
        landmarks: [
          L('Field Museum', 'Museum', -87.6170, 41.8663, ['field museum of natural history']),
          L('Shedd Aquarium', 'Museum', -87.6140, 41.8676, ['shedd', 'aquarium']),
          L('Soldier Field', 'Stadium', -87.6167, 41.8623, ['bears game']),
          L('McCormick Place', 'Convention center', -87.6157, 41.8515, ['mccormick', 'chicago convention center', 'convention center']),
          L('Buckingham Fountain', 'Sight', -87.6189, 41.8758, ['grant park']),
        ],
      }),
      A('Lincoln Park / Wrigleyville', 'Lincoln Park', 'nightlife', [-87.6450, 41.9320], {
        aliases: ['Lincoln Park', 'Wrigleyville', 'Lakeview', 'Old Town'], short: 'Lincoln Park',
        bearings: [180, 380], spreadM: 1500, features: ['subway', 'night'],
        reason: 'Neighborhood Chicago: the zoo, the lakefront path and bars around Wrigley Field.',
        landmarks: [
          L('Lincoln Park Zoo', 'Park', -87.6340, 41.9211, ['lincoln park']),
          L('Wrigley Field', 'Stadium', -87.6553, 41.9484, ['wrigley', 'cubs game']),
        ],
      }),
      A("O'Hare", 'Rosemont', 'airport', [-87.8650, 41.9790], {
        aliases: ['Ohare', 'ORD', 'Rosemont'], short: "O'Hare",
        bearings: [0, 200], spreadM: 1500, features: ['airport', 'subway'],
        reason: "Next to O'Hare with free shuttles and the Blue Line downtown; Rosemont's convention center is here too.",
        landmarks: [L("O'Hare International Airport", 'Transit hub', -87.9073, 41.9742, ["o'hare", 'ohare', 'ord', 'ohare airport', "o'hare airport"], 2000)],
      }),
    ],
  },
  {
    code: 'sea', name: 'Seattle', state: 'WA', aliases: ['the emerald city', 'emerald city'],
    zone: 'America/Los_Angeles', areaCode: '206', market: 'business', priceLevel: 1.05, tax: { rate: 0.157, perNight: 0 },
    weekdays: [0.92, 1, 1.05, 1.05, 1.05, 1, 1.05], season: [0.75, 0.75, 0.8, 0.9, 1, 1.2, 1.3, 1.3, 1.1, 0.9, 0.8, 0.8],
    center: [-122.3321, 47.6062],
    areas: [
      A('Pike Place / Downtown', 'Downtown', 'scenic', [-122.3380, 47.6090], {
        aliases: ['Pike Place', 'Pike Place Market', 'Downtown Seattle', 'Downtown', 'the Waterfront'], short: 'Pike Place',
        bearings: [0, 200], spreadM: 900, features: ['subway', 'bay', 'night'],
        reason: 'Pike Place Market, the waterfront and the cruise piers; walk everywhere, with light rail to the airport.',
        landmarks: [
          L('Pike Place Market', 'Food & drink', -122.3422, 47.6097, ['pike place', 'the market', 'public market']),
          L('Seattle Waterfront', 'Sight', -122.3405, 47.6062, ['waterfront', 'pier 57', 'great wheel', 'seattle great wheel']),
          L('Seattle Art Museum', 'Museum', -122.3381, 47.6073, []),
          L('Bell Street Cruise Terminal (Pier 66)', 'Transit hub', -122.3480, 47.6115, ['pier 66', 'cruise terminal', 'cruise port']),
          L('Seattle Aquarium', 'Museum', -122.3431, 47.6076, ['aquarium']),
        ],
      }),
      A('Seattle Center / Queen Anne', 'Lower Queen Anne', 'scenic', [-122.3493, 47.6205], {
        aliases: ['Seattle Center', 'Space Needle', 'Queen Anne', 'Lower Queen Anne', 'South Lake Union'], short: 'Seattle Center',
        bearings: [330, 560], spreadM: 900, features: ['family', 'bay'],
        reason: 'The Space Needle, MoPOP and Chihuly next door; a short monorail ride to Downtown.',
        landmarks: [
          L('Space Needle', 'Sight', -122.3493, 47.6205, ['the needle']),
          L('Museum of Pop Culture', 'Museum', -122.3481, 47.6215, ['mopop', 'emp museum']),
          L('Chihuly Garden and Glass', 'Museum', -122.3505, 47.6206, ['chihuly']),
          L('Climate Pledge Arena', 'Stadium', -122.3540, 47.6221, ['key arena']),
        ],
      }),
      A('Capitol Hill', 'Capitol Hill', 'nightlife', [-122.3200, 47.6200], {
        aliases: ['Cap Hill', 'Pike/Pine'], short: 'Capitol Hill',
        spreadM: 900, features: ['subway', 'night'],
        reason: "Seattle's liveliest bars, coffee and live music, with light rail at the doorstep.",
        landmarks: [
          L('Volunteer Park', 'Park', -122.3150, 47.6303, ['volunteer park conservatory']),
          L('Cal Anderson Park', 'Park', -122.3196, 47.6170, []),
        ],
      }),
      A('SeaTac', 'SeaTac', 'airport', [-122.2965, 47.4440], {
        aliases: ['Sea-Tac', 'Seattle Airport', 'International Boulevard'], short: 'SeaTac',
        bearings: [350, 550], spreadM: 1500, features: ['airport', 'subway'],
        reason: 'Airport hotels on International Boulevard; light rail to Downtown in 40 minutes.',
        landmarks: [L('Seattle-Tacoma International Airport', 'Transit hub', -122.3088, 47.4502, ['sea-tac', 'seatac', 'seattle airport', 'seattle tacoma airport', 'sea airport'], 1500)],
      }),
    ],
  },
  {
    code: 'bos', name: 'Boston', state: 'MA', aliases: ['beantown', 'bos'],
    zone: 'America/New_York', areaCode: '617', market: 'business', priceLevel: 1.3, tax: { rate: 0.1645, perNight: 0 },
    weekdays: [0.9, 1, 1.08, 1.08, 1.05, 1, 1.05], season: [0.7, 0.7, 0.8, 0.95, 1.1, 1.15, 1.15, 1.15, 1.2, 1.25, 0.9, 0.85],
    center: [-71.0589, 42.3601],
    areas: [
      A('Back Bay', 'Back Bay', 'shopping', [-71.0800, 42.3490], {
        aliases: ['Copley', 'Copley Square', 'Newbury Street', 'Fenway'], short: 'Back Bay',
        bearings: [70, 290], spreadM: 1000, features: ['subway', 'quiet'],
        reason: 'Brownstones, Newbury Street shopping and the Public Garden; Fenway Park is a short walk.',
        landmarks: [
          L('Copley Square', 'Sight', -71.0770, 42.3500, ['copley', 'trinity church']),
          L('Boston Public Library', 'Sight', -71.0782, 42.3493, ['central library']),
          L('Newbury Street', 'Shopping', -71.0810, 42.3510, ['newbury']),
          L('Fenway Park', 'Stadium', -71.0972, 42.3467, ['fenway', 'red sox game'], 0, 'Fenway'),
          L('Boston Public Garden', 'Park', -71.0702, 42.3541, ['public garden', 'swan boats']),
        ],
      }),
      A('Seaport', 'Seaport District', 'cbd', [-71.0450, 42.3490], {
        aliases: ['Seaport District', 'South Boston Waterfront', 'Fan Pier'], short: 'Seaport',
        bearings: [150, 290], spreadM: 800, features: ['harbor', 'night', 'skyline'],
        reason: 'Harbor views, new restaurants and the convention center; one stop from South Station.',
        landmarks: [
          L('Institute of Contemporary Art', 'Museum', -71.0430, 42.3529, ['ica', 'ica boston']),
          L('Boston Convention and Exhibition Center', 'Convention center', -71.0453, 42.3459, ['bcec', 'convention center']),
          L('Boston Harborwalk', 'Sight', -71.0465, 42.3542, ['harborwalk', 'fan pier']),
        ],
      }),
      A('Downtown / Faneuil Hall', 'Downtown', 'oldtown', [-71.0590, 42.3570], {
        aliases: ['Downtown Boston', 'Downtown', 'Faneuil Hall', 'North End', 'Freedom Trail', 'Government Center'], short: 'Faneuil Hall',
        bearings: [170, 370], spreadM: 800, features: ['subway', 'night'],
        reason: 'The Freedom Trail, Faneuil Hall and North End cannoli; history on every corner.',
        landmarks: [
          L('Faneuil Hall Marketplace', 'Shopping', -71.0568, 42.3600, ['faneuil hall', 'quincy market']),
          L('Boston Common', 'Park', -71.0656, 42.3550, ['freedom trail', 'the common'], 300),
          L('North End', 'Food & drink', -71.0542, 42.3647, ['little italy', 'hanover street']),
          L('New England Aquarium', 'Museum', -71.0498, 42.3591, ['aquarium']),
          L('South Station', 'Transit hub', -71.0552, 42.3522, ['amtrak boston', 'south station bus terminal']),
        ],
      }),
      A('Cambridge', 'Cambridge', 'university', [-71.1050, 42.3680], {
        aliases: ['Harvard', 'Harvard Square', 'MIT', 'Kendall Square'], short: 'Cambridge',
        bearings: [270, 450], spreadM: 1300, features: ['subway', 'quiet'],
        reason: 'Harvard and MIT, bookstores and cafés; the Red Line gets you downtown in 15 minutes.',
        landmarks: [
          L('Harvard University', 'University', -71.1167, 42.3770, ['harvard', 'harvard yard', 'harvard square'], 400),
          L('Massachusetts Institute of Technology', 'University', -71.0942, 42.3601, ['mit'], 400),
          L('Kendall Square', 'Landmark', -71.0865, 42.3625, ['kendall']),
        ],
      }),
      A('Logan Airport', 'East Boston', 'airport', [-71.0330, 42.3720], {
        aliases: ['Logan', 'East Boston'], short: 'Logan Airport',
        bearings: [300, 420], spreadM: 1000, features: ['airport', 'subway'],
        reason: 'Five minutes to the terminals by shuttle, and the Blue Line to downtown.',
        landmarks: [L('Boston Logan International Airport', 'Transit hub', -71.0096, 42.3656, ['logan', 'logan airport', 'boston airport'], 1200)],
      }),
    ],
  },
  {
    code: 'dc', name: 'Washington DC', state: 'DC', aliases: ['washington', 'washington, dc', 'washington d.c.', 'washington, d.c.', 'dc', 'd.c.', 'the district'],
    zone: 'America/New_York', areaCode: '202', market: 'business', priceLevel: 1.1, tax: { rate: 0.1495, perNight: 0 },
    weekdays: [0.85, 1, 1.1, 1.1, 1.05, 0.9, 0.9], season: [0.8, 0.85, 1.05, 1.2, 1.1, 1.05, 0.95, 0.85, 1, 1.05, 0.9, 0.85],
    center: [-77.0369, 38.9072],
    areas: [
      A('National Mall / Downtown', 'Downtown', 'scenic', [-77.0280, 38.8990], {
        aliases: ['National Mall', 'the Mall', 'Downtown DC', 'Penn Quarter', 'Downtown'], short: 'National Mall',
        bearings: [270, 450], spreadM: 1200, features: ['subway', 'family'],
        reason: 'Walk to the monuments and the free Smithsonian museums, with Metro stations everywhere.',
        landmarks: [
          L('National Mall', 'Park', -77.0230, 38.8895, ['the mall'], 1500),
          L('Washington Monument', 'Sight', -77.0353, 38.8895, []),
          L('Lincoln Memorial', 'Sight', -77.0502, 38.8893, []),
          L('White House', 'Sight', -77.0365, 38.8977, ['the white house']),
          L('U.S. Capitol', 'Sight', -77.0091, 38.8899, ['capitol', 'us capitol', 'capitol building']),
          L('National Air and Space Museum', 'Museum', -77.0199, 38.8882, ['air and space museum', 'smithsonian', 'smithsonian museums']),
        ],
      }),
      A('Georgetown', 'Georgetown', 'oldtown', [-77.0650, 38.9060], {
        aliases: ['M Street', 'Georgetown Waterfront'], short: 'Georgetown',
        bearings: [280, 460], spreadM: 800, features: ['river', 'quiet', 'night'],
        reason: 'Cobblestone streets, waterfront dining and boutiques; charming, but there is no Metro stop.',
        landmarks: [
          L('Georgetown Waterfront Park', 'Park', -77.0610, 38.9026, ['georgetown waterfront', 'washington harbour']),
          L('M Street', 'Shopping', -77.0630, 38.9050, ['m street shopping']),
          L('Georgetown University', 'University', -77.0723, 38.9076, []),
          L('C&O Canal Towpath', 'Park', -77.0600, 38.9040, ['c&o canal', 'c and o canal']),
        ],
      }),
      A('Dupont Circle', 'Dupont Circle', 'nightlife', [-77.0434, 38.9096], {
        aliases: ['Dupont', 'Embassy Row', 'Logan Circle', 'U Street'], short: 'Dupont Circle',
        spreadM: 900, features: ['subway', 'night'],
        reason: 'Embassy Row mansions, bookshops and bars; lively but residential, on the Red Line.',
        landmarks: [
          L('Dupont Circle', 'Landmark', -77.0434, 38.9096, []),
          L('Embassy Row', 'Sight', -77.0500, 38.9128, ['massachusetts avenue']),
          L('U Street Corridor', 'Nightlife', -77.0290, 38.9170, ['u street'], 0, 'U Street'),
        ],
      }),
      A('Capitol Hill / Union Station', 'Capitol Hill', 'station', [-77.0060, 38.8980], {
        aliases: ['Capitol Hill', 'Union Station', 'NoMa'], short: 'Capitol Hill',
        spreadM: 900, features: ['subway', 'station'],
        reason: 'Amtrak and Metro at Union Station, with the Capitol a few blocks away.',
        landmarks: [
          L('Washington Union Station', 'Transit hub', -77.0063, 38.8973, ['union station', 'amtrak dc']),
          L('Library of Congress', 'Sight', -77.0047, 38.8887, []),
        ],
      }),
      A('Crystal City / DCA', 'Crystal City, Arlington', 'airport', [-77.0510, 38.8570], {
        aliases: ['DCA', 'Reagan National', 'National Airport', 'Crystal City', 'Arlington', 'Pentagon City'], short: 'Crystal City',
        bearings: [180, 360], spreadM: 1200, features: ['airport', 'subway'],
        reason: 'Across the river in Arlington: a short walk or Metro ride to DCA, ten minutes to the Mall.',
        landmarks: [
          L('Ronald Reagan Washington National Airport', 'Transit hub', -77.0402, 38.8512, ['dca', 'reagan national', 'national airport', 'reagan airport'], 900),
          L('The Pentagon', 'Sight', -77.0563, 38.8719, ['pentagon']),
        ],
      }),
    ],
  },
  {
    code: 'nola', name: 'New Orleans', state: 'LA', aliases: ['nola', 'the big easy', 'big easy', 'crescent city'],
    zone: 'America/Chicago', areaCode: '504', market: 'leisure', priceLevel: 0.95, tax: { rate: 0.1625, perNight: 3 },
    weekdays: [0.9, 0.9, 0.9, 0.95, 1, 1.3, 1.35], season: [0.95, 1.15, 1.15, 1.15, 1.05, 0.85, 0.8, 0.75, 0.85, 1.05, 1.05, 0.95],
    center: [-90.0715, 29.9511],
    areas: [
      A('French Quarter', 'French Quarter', 'inn', [-90.0650, 29.9590], {
        aliases: ['the Quarter', 'Vieux Carré', 'Bourbon Street', 'Jackson Square', 'Marigny'], short: 'French Quarter',
        bearings: [225, 405], spreadM: 600, features: ['night', 'oldtown', 'river'],
        reason: 'Jazz on Bourbon and Frenchmen streets, courtyards and balconies; loud at night near Bourbon.',
        landmarks: [
          L('Bourbon Street', 'Nightlife', -90.0650, 29.9590, ['bourbon st', 'bourbon']),
          L('Jackson Square', 'Sight', -90.0629, 29.9574, ['st. louis cathedral', 'saint louis cathedral']),
          L('French Market', 'Food & drink', -90.0571, 29.9609, ['french market place']),
          L('Frenchmen Street', 'Nightlife', -90.0577, 29.9640, ['frenchmen st', 'the marigny'], 0, 'Marigny'),
          L('Preservation Hall', 'Nightlife', -90.0653, 29.9583, ['preservation hall jazz']),
        ],
      }),
      A('Warehouse District / CBD', 'Warehouse District', 'cbd', [-90.0700, 29.9470], {
        aliases: ['CBD', 'Central Business District', 'Warehouse District', 'Arts District', 'Canal Street'], short: 'Warehouse District',
        bearings: [180, 360], spreadM: 800, features: ['night', 'river'],
        reason: 'Big hotels near the convention center, the WWII Museum and the Superdome; a short walk to the Quarter.',
        landmarks: [
          L('The National WWII Museum', 'Museum', -90.0700, 29.9430, ['wwii museum', 'world war ii museum', 'ww2 museum']),
          L('Caesars Superdome', 'Stadium', -90.0812, 29.9511, ['superdome', 'the dome', 'saints game']),
          L('Ernest N. Morial Convention Center', 'Convention center', -90.0632, 29.9409, ['convention center', 'morial convention center']),
          L('Canal Street', 'Shopping', -90.0700, 29.9530, ['canal st']),
        ],
      }),
      A('Garden District', 'Garden District', 'inn', [-90.0840, 29.9280], {
        aliases: ['Magazine Street', 'Uptown', 'St. Charles Avenue'], short: 'Garden District',
        spreadM: 900, features: ['quiet', 'oldtown'],
        reason: 'Oak-shaded mansions, Magazine Street shops and the St. Charles streetcar; calm and pretty.',
        landmarks: [
          L('Garden District', 'Sight', -90.0840, 29.9285, ['garden district homes']),
          L('Magazine Street', 'Shopping', -90.0800, 29.9240, ['magazine st']),
          L('Lafayette Cemetery No. 1', 'Sight', -90.0850, 29.9290, ['lafayette cemetery']),
          L('St. Charles Avenue Streetcar', 'Transit hub', -90.0790, 29.9330, ['streetcar', 'st charles streetcar']),
        ],
      }),
      A('New Orleans Airport', 'Kenner', 'airport', [-90.2440, 29.9880], {
        aliases: ['MSY', 'Kenner', 'Louis Armstrong Airport'], short: 'MSY Airport',
        bearings: [60, 240], spreadM: 1200, features: ['airport'],
        reason: 'Quick shuttles to the terminal; 25 minutes to the French Quarter without traffic.',
        landmarks: [L('Louis Armstrong New Orleans International Airport', 'Transit hub', -90.2580, 29.9934, ['msy', 'new orleans airport', 'louis armstrong airport'], 1200)],
      }),
    ],
  },
  {
    code: 'hnl', name: 'Honolulu', state: 'HI', aliases: ['oahu', "o'ahu", 'hawaii'],
    zone: 'Pacific/Honolulu', areaCode: '808', market: 'leisure', priceLevel: 1.35, tax: { rate: 0.1871, perNight: 0 },
    weekdays: [1, 0.97, 0.97, 0.97, 1, 1.05, 1.1], season: [1.2, 1.2, 1.15, 1.05, 0.95, 1.05, 1.15, 1.15, 0.9, 0.9, 0.95, 1.2],
    center: [-157.8583, 21.3069],
    areas: [
      A('Waikiki', 'Waikiki', 'beach', [-157.8380, 21.2840], {
        aliases: ['Waikiki Beach', 'Kalakaua Avenue', 'Diamond Head'], short: 'Waikiki',
        bearings: [100, 130], spreadM: 2000, features: ['sea', 'family', 'resortfee', 'mountain'],
        reason: "Hawaii's most famous beach: surf lessons, sunset mai tais and Diamond Head hikes. Most resorts add a daily resort fee, already in our prices.",
        landmarks: [
          L('Waikiki Beach', 'Beach', -157.8270, 21.2760, ['waikiki', 'kuhio beach'], 900),
          L('Diamond Head State Monument', 'Sight', -157.8056, 21.2614, ['diamond head', 'diamond head crater', 'diamond head hike'], 600),
          L('International Market Place', 'Shopping', -157.8277, 21.2777, ['kalakaua avenue']),
          L('Duke Kahanamoku Statue', 'Sight', -157.8268, 21.2761, ['duke statue']),
          L('Kapiolani Park', 'Park', -157.8195, 21.2665, ['honolulu zoo', 'waikiki aquarium'], 400),
        ],
      }),
      A('Ala Moana', 'Ala Moana', 'shopping', [-157.8440, 21.2930], {
        aliases: ['Ala Moana Center', 'Kakaako', 'Convention Center'], short: 'Ala Moana',
        bearings: [270, 450], spreadM: 900, features: ['sea'],
        reason: 'Next to the big Ala Moana mall and beach park; a calmer, cheaper base ten minutes from Waikiki.',
        landmarks: [
          L('Ala Moana Center', 'Shopping', -157.8435, 21.2913, ['ala moana mall']),
          L('Ala Moana Beach Park', 'Beach', -157.8495, 21.2898, ['magic island'], 400),
          L('Hawaii Convention Center', 'Convention center', -157.8378, 21.2893, ['convention center']),
        ],
      }),
      A('Downtown Honolulu', 'Downtown', 'cbd', [-157.8600, 21.3100], {
        aliases: ['Downtown', 'Chinatown', 'Aloha Tower'], short: 'Downtown Honolulu',
        bearings: [330, 510], spreadM: 800, features: ['sea'],
        reason: "Iolani Palace, Chinatown's food and the harbor; quiet after office hours.",
        landmarks: [
          L('Iolani Palace', 'Sight', -157.8590, 21.3069, ['iolani']),
          L('Aloha Tower', 'Sight', -157.8664, 21.3069, ['aloha tower marketplace']),
          L('Honolulu Chinatown', 'Food & drink', -157.8630, 21.3120, ['chinatown']),
        ],
      }),
      A('Honolulu Airport', 'Airport', 'airport', [-157.9140, 21.3330], {
        aliases: ['HNL', 'Pearl Harbor'], short: 'Honolulu Airport',
        bearings: [330, 480], spreadM: 1500, features: ['airport'],
        reason: 'Close to the terminals and Pearl Harbor; good for a late arrival or an early flight.',
        landmarks: [
          L('Daniel K. Inouye International Airport', 'Transit hub', -157.9225, 21.3187, ['hnl', 'honolulu airport', 'honolulu international airport'], 1500),
          L('Pearl Harbor National Memorial', 'Sight', -157.9496, 21.3649, ['pearl harbor', 'uss arizona memorial', 'uss arizona']),
        ],
      }),
    ],
  },
  {
    code: 'sd', name: 'San Diego', state: 'CA', aliases: ['sd', 'america\'s finest city'],
    zone: 'America/Los_Angeles', areaCode: '619', market: 'leisure', priceLevel: 1.05, tax: { rate: 0.127, perNight: 0 },
    weekdays: [0.95, 0.95, 0.95, 0.95, 1, 1.2, 1.3], season: [0.85, 0.85, 0.9, 0.95, 1, 1.15, 1.3, 1.3, 1, 0.95, 0.85, 0.85],
    center: [-117.1611, 32.7157],
    areas: [
      A('Gaslamp Quarter', 'Downtown', 'nightlife', [-117.1600, 32.7130], {
        aliases: ['Gaslamp', 'Downtown San Diego', 'Downtown', 'Little Italy', 'East Village'], short: 'Gaslamp',
        bearings: [330, 480], spreadM: 900, features: ['subway', 'night', 'bay'],
        reason: 'Restaurants and rooftop bars, the ballpark and the convention center; the trolley and the harbor are close.',
        landmarks: [
          L('Gaslamp Quarter', 'Nightlife', -117.1597, 32.7114, ['gaslamp', 'fifth avenue']),
          L('Petco Park', 'Stadium', -117.1566, 32.7076, ['padres game', 'ballpark']),
          L('San Diego Convention Center', 'Convention center', -117.1622, 32.7066, ['convention center', 'comic-con']),
          L('Seaport Village', 'Shopping', -117.1710, 32.7090, []),
          L('USS Midway Museum', 'Museum', -117.1751, 32.7137, ['midway', 'uss midway']),
          L('Little Italy', 'Food & drink', -117.1690, 32.7234, ['little italy san diego']),
        ],
      }),
      A('La Jolla', 'La Jolla', 'beach', [-117.2730, 32.8440], {
        aliases: ['La Jolla Cove', 'La Jolla Shores', 'UC San Diego'], short: 'La Jolla',
        bearings: [60, 200], spreadM: 1300, features: ['sea', 'quiet'],
        reason: 'Seals at the Cove, kayaking and tide pools; upscale and calm, 20 minutes north of Downtown.',
        landmarks: [
          L('La Jolla Cove', 'Beach', -117.2720, 32.8504, ['the cove', "children's pool", 'seals'], 200),
          L('La Jolla Shores', 'Beach', -117.2570, 32.8580, [], 400),
          L('Birch Aquarium', 'Museum', -117.2507, 32.8656, ['birch aquarium at scripps']),
          L('Torrey Pines State Natural Reserve', 'Park', -117.2530, 32.9230, ['torrey pines'], 800),
        ],
      }),
      A('Balboa Park / Hillcrest', 'Hillcrest', 'scenic', [-117.1630, 32.7484], {
        aliases: ['Balboa Park', 'Hillcrest', 'San Diego Zoo', 'North Park'], short: 'Balboa Park',
        bearings: [200, 450], spreadM: 1000, features: ['family', 'quiet'],
        reason: 'Walk to the San Diego Zoo and the Balboa Park museums; relaxed neighborhood cafés.',
        landmarks: [
          L('Balboa Park', 'Park', -117.1446, 32.7341, [], 900),
          L('San Diego Zoo', 'Sight', -117.1490, 32.7353, ['the zoo', 'sd zoo'], 300),
        ],
      }),
      A('Coronado', 'Coronado', 'resort', [-117.1790, 32.6860], {
        aliases: ['Coronado Island', 'Coronado Beach'], short: 'Coronado',
        bearings: [300, 480], spreadM: 700, features: ['sea', 'family', 'quiet', 'resortfee'],
        reason: 'A wide, quiet beach and a small-town feel across the bay; great with kids.',
        landmarks: [
          L('Coronado Beach', 'Beach', -117.1800, 32.6810, ['coronado central beach'], 600),
          L('Coronado Ferry Landing', 'Transit hub', -117.1700, 32.6990, ['ferry landing']),
        ],
      }),
      A('San Diego Airport', 'Middletown', 'airport', [-117.1740, 32.7300], {
        aliases: ['SAN', 'Lindbergh Field', 'Harbor Island', 'Old Town'], short: 'San Diego Airport',
        bearings: [0, 160], spreadM: 900, features: ['airport', 'bay'],
        reason: 'Five minutes from the terminals and Little Italy; the trolley runs to Old Town and Downtown.',
        landmarks: [
          L('San Diego International Airport', 'Transit hub', -117.1933, 32.7338, ['san diego airport', 'lindbergh field'], 1000),
          L('Old Town San Diego', 'Sight', -117.1970, 32.7549, ['old town'], 0, 'Old Town'),
        ],
      }),
    ],
  },
  {
    code: 'bna', name: 'Nashville', state: 'TN', aliases: ['music city', 'nash'],
    zone: 'America/Chicago', areaCode: '615', market: 'leisure', priceLevel: 1.05, tax: { rate: 0.1525, perNight: 2.5 },
    weekdays: [0.85, 0.85, 0.88, 0.92, 1.05, 1.45, 1.55], season: [0.8, 0.85, 0.95, 1.05, 1.1, 1.15, 1.1, 1, 1.05, 1.1, 1, 0.9],
    center: [-86.7816, 36.1627],
    areas: [
      A('Lower Broadway / Downtown', 'Downtown', 'nightlife', [-86.7790, 36.1600], {
        aliases: ['Broadway', 'Lower Broadway', 'Downtown Nashville', 'Downtown', 'Honky Tonk Highway', 'SoBro'], short: 'Broadway',
        bearings: [180, 360], spreadM: 900, features: ['night', 'river'],
        reason: "Live music from noon to 2 AM in Broadway's honky-tonks, with the Ryman and the arena next door. Loud on weekends.",
        landmarks: [
          L('Lower Broadway', 'Nightlife', -86.7775, 36.1612, ['broadway', 'honky tonks', 'honky tonk highway', 'lower broad']),
          L('Ryman Auditorium', 'Sight', -86.7785, 36.1612, ['the ryman', 'ryman']),
          L('Country Music Hall of Fame and Museum', 'Museum', -86.7762, 36.1582, ['country music hall of fame', 'hall of fame']),
          L('Bridgestone Arena', 'Stadium', -86.7785, 36.1592, ['predators game']),
          L('Music City Center', 'Convention center', -86.7780, 36.1570, ['convention center']),
          L('John Seigenthaler Pedestrian Bridge', 'Sight', -86.7730, 36.1622, ['pedestrian bridge']),
        ],
      }),
      A('The Gulch', 'The Gulch', 'shopping', [-86.7860, 36.1525], {
        aliases: ['Gulch'], short: 'The Gulch',
        spreadM: 600, features: ['night'],
        reason: 'Trendy and walkable: murals, rooftop bars and good restaurants, ten minutes on foot from Broadway.',
        landmarks: [L('What Lifts You wings mural', 'Sight', -86.7856, 36.1520, ['wings mural', 'gulch mural'])],
      }),
      A('Midtown / Music Row', 'Midtown', 'university', [-86.7960, 36.1490], {
        aliases: ['Midtown', 'Music Row', 'Vanderbilt', 'West End'], short: 'Music Row',
        spreadM: 1000, features: ['night', 'quiet'],
        reason: 'Near Vanderbilt and Music Row with local bars and Centennial Park; calmer than Downtown.',
        landmarks: [
          L('Music Row', 'Sight', -86.7930, 36.1500, []),
          L('Vanderbilt University', 'University', -86.8027, 36.1447, ['vanderbilt', 'vandy'], 400),
          L('The Parthenon', 'Sight', -86.8133, 36.1497, ['parthenon', 'centennial park']),
        ],
      }),
      A('Music Valley / Opryland', 'Music Valley', 'resort', [-86.6930, 36.2120], {
        aliases: ['Opryland', 'Music Valley', 'Grand Ole Opry', 'Opry Mills'], short: 'Music Valley',
        bearings: [300, 420], spreadM: 1000, features: ['family'],
        reason: 'Next to the Grand Ole Opry and Opry Mills, with free parking; 15 minutes from Downtown.',
        landmarks: [
          L('Grand Ole Opry', 'Sight', -86.6923, 36.2068, ['the opry', 'opry']),
          L('Opry Mills', 'Shopping', -86.6950, 36.2030, []),
        ],
      }),
      A('Nashville Airport', 'Airport', 'airport', [-86.6950, 36.1400], {
        aliases: ['BNA'], short: 'Nashville Airport',
        bearings: [240, 420], spreadM: 1500, features: ['airport'],
        reason: 'Airport hotels with shuttles, 15 minutes from Broadway; often the cheapest choice on busy weekends.',
        landmarks: [L('Nashville International Airport', 'Transit hub', -86.6774, 36.1263, ['bna', 'nashville airport'], 1200)],
      }),
    ],
  },
  {
    code: 'aus', name: 'Austin', state: 'TX', aliases: ['atx'],
    zone: 'America/Chicago', areaCode: '512', market: 'business', priceLevel: 0.95, tax: { rate: 0.17, perNight: 0 },
    weekdays: [0.9, 0.95, 1, 1.05, 1.05, 1.1, 1.15], season: [0.85, 0.9, 1.3, 1.05, 1, 0.95, 0.9, 0.9, 0.95, 1.1, 1, 0.85],
    center: [-97.7431, 30.2672],
    areas: [
      A('Downtown Austin', 'Downtown', 'cbd', [-97.7431, 30.2672], {
        aliases: ['Downtown', 'Sixth Street', '6th Street', 'Rainey Street', 'Congress Avenue'], short: 'Downtown Austin',
        bearings: [270, 450], spreadM: 1000, features: ['night', 'lake', 'skyline'],
        reason: 'Sixth Street live music, Rainey Street bars and the Capitol; walk to the lake trail.',
        landmarks: [
          L('Texas State Capitol', 'Sight', -97.7404, 30.2747, ['capitol', 'state capitol']),
          L('Sixth Street', 'Nightlife', -97.7380, 30.2672, ['6th street', 'dirty sixth', 'east 6th']),
          L('Rainey Street', 'Nightlife', -97.7385, 30.2585, ['rainey st']),
          L('Lady Bird Lake', 'Park', -97.7520, 30.2620, ['town lake', 'hike and bike trail', 'butler trail'], 600),
          L('Congress Avenue Bridge bats', 'Sight', -97.7450, 30.2614, ['bat bridge', 'congress bridge', 'bats']),
          L('Austin Convention Center', 'Convention center', -97.7396, 30.2635, ['convention center', 'sxsw']),
        ],
      }),
      A('South Congress', 'South Congress', 'shopping', [-97.7495, 30.2500], {
        aliases: ['SoCo', 'Zilker', 'Barton Springs', 'South Austin'], short: 'South Congress',
        spreadM: 1000, features: ['night', 'quiet'],
        reason: 'Vintage shops, food trucks and skyline views, with Zilker Park and Barton Springs nearby.',
        landmarks: [
          L('South Congress Avenue', 'Shopping', -97.7495, 30.2500, ['soco', 'south congress']),
          L('Zilker Park', 'Park', -97.7729, 30.2669, ['zilker', 'acl', 'austin city limits'], 500),
          L('Barton Springs Pool', 'Sight', -97.7713, 30.2638, ['barton springs']),
        ],
      }),
      A('UT Austin', 'University of Texas', 'university', [-97.7420, 30.2850], {
        aliases: ['UT', 'University of Texas', 'West Campus', 'Hyde Park'], short: 'UT Austin',
        spreadM: 1000, features: ['quiet'],
        reason: 'By the UT campus and the Blanton museum; quieter, with buses straight downtown.',
        landmarks: [
          L('University of Texas at Austin', 'University', -97.7341, 30.2849, ['ut austin', 'ut', 'longhorns'], 600),
          L('Blanton Museum of Art', 'Museum', -97.7375, 30.2808, ['blanton']),
          L('Darrell K Royal–Texas Memorial Stadium', 'Stadium', -97.7325, 30.2837, ['dkr', 'texas memorial stadium', 'longhorns game']),
        ],
      }),
      A('Austin Airport', 'Airport', 'airport', [-97.6950, 30.2140], {
        aliases: ['AUS', 'Austin-Bergstrom'], short: 'Austin Airport',
        bearings: [180, 450], spreadM: 1500, features: ['airport'],
        reason: 'Close to the terminal and on the way to the Circuit of the Americas; 15 minutes to Downtown.',
        landmarks: [
          L('Austin-Bergstrom International Airport', 'Transit hub', -97.6664, 30.1975, ['aus', 'austin airport', 'bergstrom'], 1200),
          L('Circuit of the Americas', 'Stadium', -97.6411, 30.1328, ['cota', 'formula 1', 'f1'], 800),
        ],
      }),
    ],
  },
  {
    code: 'den', name: 'Denver', state: 'CO', aliases: ['mile high city', 'the mile high city'],
    zone: 'America/Denver', areaCode: '303', market: 'business', priceLevel: 0.9, tax: { rate: 0.1575, perNight: 0 },
    weekdays: [0.92, 1, 1.05, 1.05, 1, 1, 1.05], season: [0.85, 0.85, 0.9, 0.9, 1, 1.15, 1.2, 1.15, 1.05, 0.95, 0.85, 0.85],
    center: [-104.9903, 39.7392],
    areas: [
      A('LoDo / Union Station', 'LoDo', 'oldtown', [-104.9990, 39.7530], {
        aliases: ['LoDo', 'Lower Downtown', 'Union Station', 'Larimer Square'], short: 'LoDo',
        spreadM: 800, features: ['subway', 'night', 'station'],
        reason: 'Brewpubs, Larimer Square and Coors Field; trains to the airport leave from Union Station.',
        landmarks: [
          L('Denver Union Station', 'Transit hub', -105.0002, 39.7527, ['union station', 'a line', 'train to the airport']),
          L('Larimer Square', 'Food & drink', -104.9998, 39.7479, ['larimer']),
          L('Coors Field', 'Stadium', -104.9942, 39.7559, ['rockies game']),
          L('Ball Arena', 'Stadium', -105.0077, 39.7487, ['pepsi center', 'nuggets game']),
        ],
      }),
      A('Downtown Denver', 'Downtown', 'cbd', [-104.9930, 39.7450], {
        aliases: ['Downtown', '16th Street Mall', 'Convention Center'], short: 'Downtown Denver',
        spreadM: 800, features: ['subway', 'mountain', 'night'],
        reason: 'The 16th Street pedestrian mall, theaters and the convention center, with mountain views from upper floors.',
        landmarks: [
          L('16th Street Mall', 'Shopping', -104.9926, 39.7473, ['16th street', 'sixteenth street']),
          L('Colorado Convention Center', 'Convention center', -104.9946, 39.7427, ['convention center', 'blue bear']),
          L('Denver Performing Arts Complex', 'Sight', -104.9990, 39.7450, ['dcpa', 'denver center for the performing arts']),
        ],
      }),
      A('Golden Triangle', 'Golden Triangle', 'scenic', [-104.9870, 39.7370], {
        aliases: ['Capitol Hill', 'Civic Center', 'Art District'], short: 'Golden Triangle',
        spreadM: 800, features: ['quiet', 'mountain'],
        reason: 'Museums and the State Capitol around Civic Center Park; quieter, a short walk to Downtown.',
        landmarks: [
          L('Colorado State Capitol', 'Sight', -104.9848, 39.7393, ['state capitol', 'mile high step']),
          L('Denver Art Museum', 'Museum', -104.9893, 39.7372, ['art museum']),
          L('Civic Center Park', 'Park', -104.9876, 39.7396, ['civic center']),
        ],
      }),
      A('Cherry Creek', 'Cherry Creek', 'shopping', [-104.9540, 39.7180], {
        aliases: ['Cherry Creek North'], short: 'Cherry Creek',
        spreadM: 900, features: ['quiet'],
        reason: 'Upscale shops, galleries and the Cherry Creek trail; polished and calm, ten minutes from Downtown.',
        landmarks: [
          L('Cherry Creek Shopping Center', 'Shopping', -104.9530, 39.7170, ['cherry creek mall']),
          L('Denver Botanic Gardens', 'Park', -104.9601, 39.7320, ['botanic gardens']),
        ],
      }),
      A('Denver Airport', 'Gateway Park', 'airport', [-104.7700, 39.8000], {
        aliases: ['DEN', 'DIA', 'Denver International', 'Gateway Park', 'Pena Boulevard'], short: 'Denver Airport',
        spreadM: 2000, features: ['airport', 'subway'],
        reason: 'Hotels by the A Line and Peña Boulevard, 15 minutes from the terminal; good before an early flight.',
        landmarks: [L('Denver International Airport', 'Transit hub', -104.6737, 39.8494, ['den', 'dia', 'denver airport', 'denver international'], 4000)],
      }),
    ],
  },
];

function freezeDeep(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) freezeDeep(v);
  }
  return obj;
}

/** @type {ReadonlyArray<object>} */
export const CITIES = freezeDeep(RAW_CITIES.map((c) => ({
  code: c.code,
  name: c.name,
  state: c.state,
  fullName: `${c.name.replace(/ DC$/, '')}, ${c.state}`,
  aliases: [...new Set([c.name.toLowerCase(), `${c.name.replace(/ DC$/, '')}, ${c.state}`.toLowerCase(), ...c.aliases.map((a) => a.toLowerCase())])],
  zone: c.zone,
  areaCode: c.areaCode,
  market: c.market,
  priceLevel: c.priceLevel || 1,
  tax: { rate: c.tax?.rate || 0, perNight: c.tax?.perNight || 0 },
  weekdays: c.weekdays,
  season: c.season || null,
  center: { lng: c.center[0], lat: c.center[1] },
  areas: c.areas.map((a) => ({ ...a, spreadM: a.spreadM || 1200, bearings: a.bearings || [0, 360] })),
})));

export const MARKET_LABELS = Object.freeze({ business: 'Business city', mixed: 'Business and leisure', leisure: 'Leisure destination' });

export function normCityText(text) {
  return String(text || '').trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
}

/** Exact lookup by name / 'New York, NY' / alias / code; no fuzzy matching. */
export function findCity(text, cities = CITIES) {
  const q = normCityText(text);
  if (!q) return null;
  return cities.find((c) => c.name.toLowerCase() === q || c.fullName.toLowerCase() === q || c.code === q || c.aliases.includes(q)) || null;
}

export function findCityByCode(code, cities = CITIES) {
  return cities.find((c) => c.code === code) || null;
}

/** The time zone of a city (name, alias or code), or null. */
export function cityZone(text) {
  return findCity(text)?.zone || null;
}
