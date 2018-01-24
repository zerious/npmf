# npmf

**npmf** is an npm wrapper that can install faster, if you're sharing Wi-Fi with others who are using npmf.

## Install & Use

npm install --global npmf
npmf install PACKAGE_NAME

## How?
When you install with **npmf**, it starts a server which builds a list of package versions from
your npm & yarn caches, and servers on the same subnet can discover each other and share their
version lists. When you `npmf install PACKAGE_NAME`, npmf uses your local server as an npm registry.
If a version of PACKAGE_NAME is cached on a peer, your installation will fetch a tarball from the
local network, rather than using external bandwidth.
