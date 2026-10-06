// Approved umbrella and serving diagrams; coordinates are display positions.
export const FORMATIONS = {
  '1,4': {
    start: { RS: [36, 36], M1: [156, 36], OH1: [276, 36], OH2: [36, 246], M2: [156, 246], S: [276, 246] },
    serve: { RS: [104, 7], M1: [156, 7], OH1: [208, 7], OH2: [60, 156], M2: [156, 264], S: [276, 368] },
    // Base defense after the serve crosses the net, from court-positioning.html.
    base: { RS: [276, 7], M1: [156, 7], OH1: [18, 7], OH2: [60, 156], M2: [156, 264], S: [252, 156] },
    passing: {
      OH: { passers: 'Both outsides and the middle pass. RS stays up to hit. The setter runs up from the back right.',
            receive: { RS: [72, 50], M1: [156, 50], OH1: [260, 200], OH2: [36, 200], M2: [148, 235], S: [276, 245] } },
      RS: { passers: 'Four-pass umbrella: right side and front middle cover the short wings; back outside and middle cover the deeper center. OH stays stacked with the setter.',
            receive: { RS: [24, 160], M1: [288, 160], OH1: [310, 7], OH2: [108, 254], M2: [216, 254], S: [310, 58] } },
    },
  },
  '2,5': {
    start: { OH2: [36, 36], RS: [156, 36], M1: [276, 36], M2: [36, 246], S: [156, 246], OH1: [276, 246] },
    serve: { OH2: [18, 7], RS: [130, 7], M1: [182, 7], M2: [156, 264], S: [252, 156], OH1: [276, 368] },
    base: { OH2: [18, 7], RS: [276, 7], M1: [156, 7], M2: [156, 264], S: [252, 156], OH1: [60, 156] },
    passing: {
      OH: { passers: 'Four-pass umbrella: front outside and middle cover the short wings; back middle and outside cover the deeper center. RS stays stacked with the setter.',
            receive: { OH2: [24, 160], RS: [156, 15], M1: [288, 160], M2: [108, 254], S: [170, 65], OH1: [216, 254] } },
    },
  },
  '3,6': {
    start: { M2: [36, 36], OH2: [156, 36], RS: [276, 36], S: [36, 246], OH1: [156, 246], M1: [276, 246] },
    serve: { M2: [130, 7], OH2: [182, 7], RS: [276, 7], S: [110, 120], OH1: [160, 135], M1: [276, 368] },
    base: { M2: [156, 7], OH2: [18, 7], RS: [276, 7], S: [252, 156], OH1: [60, 156], M1: [156, 264] },
    passing: {
      OH: { passers: 'Four-pass umbrella: front outside and right side cover the short wings; back outside and middle cover the deeper center. Front middle stays stacked with the setter.',
            receive: { M2: [0, 15], OH2: [24, 160], RS: [288, 160], S: [0, 65], OH1: [108, 254], M1: [216, 254] } },
      RS: { passers: 'Four-pass umbrella: front outside and right side cover the short wings; back outside and middle cover the deeper center. Front middle stays stacked with the setter.',
            receive: { M2: [0, 15], OH2: [24, 160], RS: [288, 160], S: [0, 65], OH1: [108, 254], M1: [216, 254] } },
    },
  },
};
