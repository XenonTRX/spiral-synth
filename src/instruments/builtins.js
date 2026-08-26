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

import './subtractive.js';
import './fm.js';
import './ladder.js';
import './wavetable.js';
import './drums.js';
