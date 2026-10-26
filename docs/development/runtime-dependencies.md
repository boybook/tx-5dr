# Runtime dependency sources

Committed manifests and `yarn.lock` must install from a standalone TX-5DR checkout.
CI runners, Docker build contexts and packaged consumers have no sibling protocol
library checkouts. Local `portal:` links are temporary development overrides and
must stay out of shared branches.

Prefer a registry version that contains every required public API. If a dependency
has required changes that are not yet released, pin its full Git commit. Its pack
hook must produce the ESM, CommonJS and declaration entries named in `exports`;
neither a developer's existing `dist` directory nor a CI checkout of a moving branch
may supply those files. Replace the Git pin with a verified registry version when
that version is published.

`tci-client-node` is currently pinned this way because the registry release does
not yet include the Line Out dialect and parameter controls used by TX-5DR. The
library owns compilation through `prepack`; TX-5DR owns the dependency reference
and Yarn lockfile. Publishing that library is a separate operation.

After local portal testing, restore the shared dependency reference and regenerate
the lockfile with the repository's pinned Yarn version. Validate dependency changes
in a fresh source export without sibling checkouts or pre-existing `node_modules`:

```sh
yarn install --immutable
yarn build
yarn test:tci-controls-integration
```

The install must preserve the lockfile. Verify public entries from the installed
package, including `tci-client-node/controls` and `tci-client-node/testing`, before
relying on source-level tests. CI uses immutable installs and Yarn 4 configuration
such as `YARN_HTTP_TIMEOUT`; dependency errors must not trigger lockfile rewrites
or obsolete dependency repair scripts.

Packaged startup checks must use an environment meeting the distributed native
libraries' requirements (currently GLIBC 2.38 and GLIBCXX 3.4.32). Linux build
runners use Ubuntu 24.04; Android PRoot and Docker use Debian 13. Linux hosts
must meet these runtime-library requirements before starting the app. The
installer does not add a newer Debian repository to upgrade system libraries
across distribution versions. Windows audify retains its source-build
policy for the existing WASAPI patch.

The Windows audify patch releases the WASAPI device enumerator before COM
uninitialization. Reversing that order can unload `MMDevApi.dll` before its
interface is released during garbage collection, crashing even without an
open audio stream. Windows CI exercises repeated enumeration and collection
as well as full packaged server startup.
