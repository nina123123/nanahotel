# NanaHotel art: image prompts for Codex

Generate these one at a time in Codex with `$imagegen`. When they're done, drag the images straight into the chat
with Claude (several at once is fine); Claude crops, compresses and adds them to the project, so there's no need to
save them to the repository yourself. Until then the app draws Nana as SVG and shows tinted placeholders for photos.

## 1. Nana, the 3D plush capybara (10 images)

Generate image 1, the **reference image**, first. Make the other 9 **from image 1 as the reference** (edit mode) so it
stays the same capybara: the same fur color, proportions, orange and style; only the expression and pose change.

**1. Reference (calm) `idle`**
```
$imagegen A 3D-rendered mascot character named "Nana": a chibi capybara with the look of a plush toy (fine, short,
velvety fur that looks soft to the touch), a round chubby body with the big head and body as one shape, warm caramel
fur, a big round dark-brown nose, small shiny black eyes with highlights, soft pink blush, two small round ears, and a
small orange with one green leaf sitting on top of its head.
A calm, gentle, slight smile (very relaxed and unbothered). Facing the camera, sitting, two little paws resting on its
tummy. Soft studio lighting, a polished Pixar / designer-toy 3D look, clean, no text.
Transparent background PNG, 1024×1024, the character centered with a little space around it.
```

Start each of the next prompts with:
```
$imagegen Using the capybara "Nana" from the previous image as the reference, keep exactly the same character, fur color, proportions, orange and 3D plush style, transparent background PNG, 1024×1024, and change only the expression and pose:
```
then add one of these lines:

2. `listening`: head tilted slightly to one side, ears perked up, eyes looking down, as if listening closely to you.
3. `thinking`: eyes looking up, one little paw on its chin, two small white thought bubbles above its head.
4. `talking`: mouth slightly open as if speaking, one little paw raised as if explaining something to you.
5. `happy`: eyes closed into happy crescents, a big open-mouthed laugh, both paws raised in a cheer, brighter blush, a few small stars floating around it.
6. `sleepy`: eyes closed, head tilted a little, a tiny snot bubble on its nose, "Zzz" floating above its head.
7. `oops`: an awkward little smile, a blue sweat drop on its forehead, one paw scratching its head.
8. `poke`: startled, eyes squeezed shut like "> <", the orange on its head bouncing up into the air.
9. `wave`: happily waving one little paw hello, smiling.
10. `onsen`: soaking in a steaming hot-spring pool with only its head and shoulders above the water, three or four small oranges floating on the surface, eyes closed, blissful (this one may include the hot-spring scene and doesn't need a transparent background; square).

## 2. Hotel photos (15 images)

Add this to the end of every prompt:
```
Photorealistic photography, natural light, warm tones, clean and tidy, no people, no text, no logos or signs,
landscape 1536×1024. A contemporary American hotel.
```

The names are the keys the app looks up (public/cards.js), so keep them exactly as written.

Hotel covers (by category and setting):
1. `cover-economy` (budget): the front desk and lobby of a bright, simple, spotless limited-service hotel off a US highway or downtown street; light colors, a small coffee station.
2. `cover-comfort` (midscale): a welcoming modern lobby with light wood, plants and a lounge with sofas and a fireplace.
3. `cover-premium` (upscale): a design-forward lobby with warm lighting, a lobby bar and an art installation.
4. `cover-luxury` (luxury): a grand five-star lobby, double-height ceiling, marble floors, a crystal chandelier, fresh flowers.
5. `cover-lake` (waterfront): the view from a hotel balcony over the ocean at a Florida or Hawaii beach in the early morning, palm trees, loungers below.
6. `cover-city` (skyline): a big-city skyline at night through the floor-to-ceiling window of a high-floor room, like New York or Chicago.
7. `cover-courtyard` (boutique inn): the courtyard of a historic boutique inn: brick walls, wrought-iron balconies, ferns, string lights and a small fountain, like the French Quarter.

Rooms:
8. `room-king-economy`: a compact, clean budget king room, white bedding, a work desk and a TV.
9. `room-twin`: a two-queen room, two queen beds with a nightstand between them, a small armchair by the window.
10. `room-king-comfort`: a midscale king room in light wood tones, warm reading lamps, a lounge chair.
11. `room-king-deluxe`: a deluxe king room with a large floor-to-ceiling window onto the city, a rug and an armchair.
12. `room-family`: a family room with a king bed plus a bunk bed for kids and a few playful touches.
13. `room-suite`: the living room of a hotel suite, a sofa and coffee table, the bedroom visible through an open door.

Other:
14. `breakfast`: a hotel breakfast buffet: a waffle station, scrambled eggs, bacon, pastries, fresh fruit, juice and coffee.
15. `pool`: a hotel's outdoor pool at golden hour with loungers and umbrellas, calm water.
