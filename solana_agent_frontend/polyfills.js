// Must be imported BEFORE any Solana/crypto libraries
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import { Buffer } from "buffer";

global.Buffer = global.Buffer || Buffer;

// Also polyfill process for some Node.js libraries
if (typeof process === "undefined") {
    global.process = { env: {} };
}
