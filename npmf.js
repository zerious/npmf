#! /usr/bin/env node
var fs = require('fs')
var os = require('os')
var http = require('http')
var zlib = require('zlib')
var proc = require('child_process')
var log = console.log
var env = process.env
var win = process.platform === 'win32'
var home = win && env.USERPROFILE || env.HOME
var ip = locate()
var me = parseInt(ip.split('.')[3])
var argv = process.argv
var command = argv[2]
var port = 23456
var map = {}
var peers = {}
var wait = 0
var count = 0
var finishedCount = 0
var spawned = false

if (command === 'install' || command === 'i') {
  install()
} else if (command === 'serve') {
  serve()
} else {
  // TODO: Help.
}

// Install a dependency.
function install () {
  // Connect to localhost, or try again.
  var server
  function connect () {
    poll(me, function (map) {
      if (map) return use(map)
      if (!server) server = proc.fork('npmf', ['serve'])
      setTimeout(connect, 1e3)
    })
  }
  connect()
  
  function use (map) {
    // log(map)
  } 
}

// Start the server.
function serve () {
  // Listen for connections.
  http.createServer(function (req, res) {
    if (req.url === '/') {
      var out = {}
      for (var name in map) {
        out[name] = Object.keys(map[name])
      }
      res.send(out)
    } else if (req.url === '/ping') {
      res.end('pong')
    }
  }).listen(port)
  log('Listening (http://' + ip + ':' + port + ').')
  
  // Discover neighbors.
  discover()
  
  // Rediscover neighbors after network changes.
  setInterval(function () {
    var newIp = locate()
    if (newIp !== ip) {
      ip = newIp
      me = parseInt(ip.split('.')[3])
      log('Network changed (' + ip + ').')
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
  zlib.deflate(JSON.stringify(data), function (ignore, enc) {
    res.end(enc)
  })
}

// Find the NPM and Yarn caches, and map their tarballs.
function build () {
  return [
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
          add(match[1], match[2], this.path + '/' + dir + '.yarn-tarball.tgz')
        }
      }
    })
  ]
}

// Generic package management tool.
function Tool (options) {
  var self = this
  for (var key in options) self[key] = options[key]
  wait++
  proc.exec(self.name + ' ' + self.cmd, function (ignore, out, err) {
    self.path = self.parse(out)
    list(self.path, function (name) {
      self.dive(name)
    })
    unwait()
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

// Add a dependency version to the local map.
function add (name, v, path) {
  var versions = map[name] = map[name] || {}
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
  if (!finishedCount) {
    log('Found ' + count + ' versions.')
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
      if ((ip.family === 'IPv4') && !ip.internal) {
        return ip.address
      }
    }
  }
  return '127.0.0.1'
}

// Find NPMF peers on the same subnet.
function discover () {
  for (var i = me + 1; i < me + 256; i++) {
    poll(i % 256, function (data) {
      if (data) {
        log(data)
      }
    })
  }
}

// Poll a peer.
function poll (i, fn) {
  get(i, '/', function (res) {
    if (!res) return fn()
    var inflate = zlib.createInflate()
    var data = ''
    res.pipe(inflate)
    inflate
      .on('data', function (chunk) { data += chunk })
      .on('close', function () { fn(parse(data)) })
  })
}

// Get a JSON response from a peer.
function get (i, path, fn) {
  var host = ip.replace(/\d+$/, i)
  var url = 'http://' + host + ':' + port + path
  http.get(url, fn).on('error', function () { fn() })
}
