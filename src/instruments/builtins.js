// Importing this registers every instrument that ships with the app.
//
// It exists so that adding one is a line here rather than an edit to the model, the panel or the
// scope - all three ask the registry what exists rather than being told. It is also the reason
// the registry module imports nothing: an instrument imports the registry to register itself, so
// if the registry imported instruments back the pair would be circular and whichever evaluated
// second would find the other half-built.
//
// The order is the order presets are offered in, and the first one registered is what a part gets
// when a save names an instrument this build has never heard of.
//
// The three modelled strings sit between the synthesisers and the kit because that is what they are:
// the four above them are signal chains with knobs on the stages, and the kit below is not pitched at
// all. Everything in between is an instrument being modelled rather than a sound being built.

import './subtractive.js';
import './fm.js';
import './ladder.js';
import './wavetable.js';
import './piano.js';
import './guitar.js';
import './violin.js';
import './drums.js';
