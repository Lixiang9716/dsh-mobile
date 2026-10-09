// register.mjs — `node --import ./register.mjs` installs the spine suite's
// loader hooks (the dsh: scheme bridge) before any test module loads.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./dsh-loader-hooks.mjs', pathToFileURL(import.meta.filename));
