// The one line adding an effect costs.
//
// Imported for the side effect of registering, exactly like instruments/builtins.js, and for the same
// reason: the registry has to be populated before anything reads a saved chain, and an effect module
// that nobody imports is an effect that silently does not exist. The order here is the order the Add
// menu offers them in.

// Roughly signal-flow order, which is the order a chain usually wants building in: shape it, drive
// it, level it, widen it, then put it somewhere.
import './filter.js';
import './drive.js';
import './compressor.js';
import './chorus.js';
import './delay.js';
import './reverb.js';
