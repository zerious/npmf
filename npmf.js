#! /usr/bin/env node

var fs = require('fs')
var os = require('os')
var http = require('http')
var zlib = require('zlib')
var proc = require('child_process')

var env = process.env
var win = process.platform === 'win32'
var home = win && env.USERPROFILE || env.HOME
var local = '127.0.0.1'
var ip = locate()
var me = parseInt(ip.split('.')[3])
var port = 23456
var peers = {}
var doNothing = function () {}

var tools
var pathMap = {}
var versionMap = {}
var peerMap = {}
var wait = 0
var count = 0
var finishedCount
var rebuildTimeout

var stringify = JSON.stringify
var argv = process.argv
var command = argv[2]
var args = argv.slice(2)
var verbose = args.indexOf('--verbose') >= 0
var forked = false


if (command === 'serve') {
  serve()
} else if (!command) {
  help()
} else {
  spawn()
}

function debug () {
  if (verbose) console.log.apply(console, arguments)
}

// Show help.
function help () {
  console.log('\nUsage: npmf <command>\n\n  where <command> is "serve" or any npm command.\n')
}

// Spawn a command.
function spawn () {
  // Connect to localhost, or try again.
  var server
  function connect () {
    poll(me, local, function (data) {
      if (data) return run()
      if (!server) {
        server = proc.fork('npmf', ['serve'])
        forked = true
      }
      setTimeout(connect, 1e3)
    })
  }
  connect()

  function run () {
    args.push('--registry')
    args.push('http://' + local + ':' + port)
    debug('Spawn: npm ' + args.join(' '))
    var child = proc.spawn('npm', args, { cwd: process.cwd(), env: env })
    child.stdout.on('data', function (chunk) {
      process.stdout.write(chunk)
    })
    child.stderr.on('data', function (chunk) {
      process.stderr.write(chunk)
    })
    child.on('exit', process.exit)
  }
}

// Start the server.
function serve () {
  // Listen for connections.
  http.createServer(function (req, res) {
    var url = req.url.replace(/^\/+/, '')
    var parts = url.split(/\//g)
    var name = parts[0]

    // Respond to "/" with the full map of versions.
    if (!url) {
      var peer = req.ipv4()
      var i = parseInt(peer.split('.')[3])
      if (!peers[peer]) {
        peers[peer] = true
        poll(i, peer, doNothing)
      }
      return res.send(versionMap)

    // Tell favicon requests to get lost.
    } else if (name === 'favicon.ico') {
      return res.end()

    // If looking for information about a specific package, give a subset of what npmjs.org gives.
    } else if (parts.length === 1) {
      var versionPaths = pathMap[name]
      var versionPeers = peerMap[name]
      if (versionPaths || versionPeers) {
        var max
        var versions = {}
        var maps = [ versionPaths, versionPeers ]
        debug(maps)
        maps.forEach(function (map) {
          for (var version in map) {
            var data = { name: name, version: version }
            if (map === versionPeers) {
              var peer = ip.replace(/\d+$/, map[version])
              data.dist = {
                tarball: 'http://' + peer + ':' + port +
                  '/' + name + '/-/' + name + '-' + version + '.tgz'
              }
            }
            versions[version] = data
            max = version
          }
        })
        var data = { 'dist-tags': { latest: max }, versions: versions }
        debug('Serve: ' + stringify(data))
        return res.send(data)
      }

    // If looking for a tarball, stream it.
    } else if (parts[1] === '-') {
      var file = parts[2]
      var version = file.substring(name.length + 1, file.length - 4)
      var path = pathMap[name][version]
      if (path) {
        debug('Stream: ' + path)
        return fs.createReadStream(path).pipe(res)
      }
    }

    // If nothing matched, use registry.npmjs.org as a proxy.
    clearTimeout(rebuildTimeout)
    rebuildTimeout = setTimeout(rebuild, 1e3)
    debug('Proxy: ' + url)
    http.get('http://registry.npmjs.org/' + url, function (remote) {
      remote.pipe(res)
    })
  }).listen(port)
  debug('Listening: http://' + ip + ':' + port)

  // Discover neighbors.
  discover()

  // Rediscover neighbors after network changes.
  setInterval(function () {
    var newIp = locate()
    if (newIp !== ip) {
      ip = newIp
      me = parseInt(ip.split('.')[3])
      debug('Listening: ' + ip)
      peerMap = {}
      peers = {}
      discover()
    }
  }, 1e3)

  // Build the cache.
  build()
}

// Send compressed JSON.
http.ServerResponse.prototype.send = function (data) {
  var res = this
  res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' })
  zlib.deflate(stringify(data), function (ignore, enc) {
    res.end(enc)
  })
}

// Get the IPv4 address of an incoming request.
http.IncomingMessage.prototype.ipv4 = function () {
  return (this.connection.remoteAddress || local).replace(/^.*:/, '')
}

// Find the NPM and Yarn caches, and map their tarballs.
function build () {
  finishedCount = 0
  tools = [
    new Tool({
      name: 'npm',
      cmd: 'config list -l',
      parse: function (out) {
        return out.match(/cache = "([^"]+)"/)[1] || home + '/.npm'
      },
      dive: function (name) {
        if (name !== '_prebuilds') {
          var dir = this.path + '/' + name
          list(dir, function (v) {
            if (/\d+\.\d+\.\d+/.test(v)) {
              add(name, v, dir + '/' + v + '/package.tgz')
            }
          })
        }
      }
    }),
    new Tool({
      name: 'yarn',
      cmd: 'config current --json',
      parse: function (out) {
        return parse(parse(out).data).cacheFolder || home + '/Library/Caches/Yarn/v1'
      },
      dive: function (dir) {
        var match = dir.match(/npm-(.+)-(\d+\.\d+\.\d+.*)-[\da-f]{40}$/)
        if (match) {
          add(match[1], match[2], this.path + '/' + dir + '/.yarn-tarball.tgz')
        }
      }
    })
  ]
}

// Rebuild maps.
function rebuild () {
  tools.forEach(function (tool) {
    tool.find()
  })
}

// Generic package management tool.
function Tool (options) {
  var self = this
  for (var key in options) self[key] = options[key]
  wait++
  proc.exec(self.name + ' ' + self.cmd, function (ignore, out, err) {
    self.path = self.parse(out)
    self.find()
    unwait()
  })
}

// Traverse the a package installer's cache.
Tool.prototype.find = function () {
  var self = this
  list(self.path, function (name) {
    self.dive(name)
  })
}

// Try to parse JSON, or fail gracefully.
function parse (json) {
  try {
    return JSON.parse(json)
  } catch (ignore) {
    return {}
  }
}

// Iterate over a list of files/directories under a parent directory.
function list (dir, fn) {
  if (dir) {
    wait++
    fs.readdir(dir, function (err, files) {
      if (!err) files.forEach(fn)
      unwait()
    })
  }
}

// Add a dependency version to the local path map.
function add (name, v, path) {
  var versions = pathMap[name] || (pathMap[name] = {})
  if (typeof versions[v] !== 'string') {
    versions[v] = path
    count++
  }
}

// Signal that an async cache task is finished.
function unwait () {
  if (!--wait) finish()
}

// Signal that we're finished loading from caches.
function finish () {
  versionMap = {}
  for (var name in pathMap) {
    versionMap[name] = Object.keys(pathMap[name])
  }
  if (!finishedCount) {
    debug('Found: ' + count + ' versions')
    finishedCount = count
  }
}

// Find this host's IP address.
function locate () {
  var interfaces = os.networkInterfaces()
  for (var key in interfaces) {
    var list = interfaces[key]
    for (var i = 0; i < list.length; i++) {
      var ip = list[i]
      if ((ip.family === 'IPv4') && !ip.internal &&
        ((ip.netmask === '255.255.255.0') || !ip.netmask)) {
        return ip.address
      }
    }
  }
  return local
}

// Find NPMF peers on the same subnet.
function discover () {
  for (var i = me + 1; i < me + 256; i++) {
    var peer = ip.replace(/\d+$/, i % 256)
    poll(i % 256, peer, doNothing)
  }
}

// Poll a peer.
function poll (i, peer, fn) {
  get(peer, '/', function (res) {
    if (!res) return fn()
    var inflate = zlib.createInflate()
    var data = ''
    res.pipe(inflate)
    inflate
      .on('data', function (chunk) { data += chunk })
      .on('end', function () {
        if (data && (i !== me)) {
          data = parse(data)
          peers[peer] = true
          debug('Peers: ' + Object.keys(peers).join(', '))
          for (var name in data) {
            var versionPeers = peerMap[name] || (peerMap[name] = {})
            var dataVersions = data[name]
            dataVersions.forEach(function (v) {
              if (typeof versionPeers[v] === 'undefined') versionPeers[v] = i
            })
          }
        }
        fn(data)
      })
  })
}

// Get a JSON response from a host.
function get (peer, path, fn) {
  var url = 'http://' + peer + ':' + port + path
  http.get(url, fn).on('error', function (err) { fn() })
}
