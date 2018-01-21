#! /usr/bin/env node
var fs = require('fs')
var os = require('os')
var http = require('http')
var zlib = require('zlib')
var exec = require('child_process').exec
var ip = locate()
var log = console.log
var map = {}
var port = 23456
var wait = 0
var count = 0
var finishedCount = 0

http.ServerResponse.prototype.send = function (data) {
  var res = this
  res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' })
  zlib.deflate(JSON.stringify(data), function (ignore, enc) {
    res.end(enc)
  })
}

http.get('http://' + ip + ':' + port, function (res) {
  var inflate = zlib.createInflate()
  var data = ''
  res.pipe(inflate)
  inflate
    .on('data', function (chunk) {
      data += chunk
    })
    .on('close', function () {
      log(data)
    })
}).on('error', listen)

// eslint-disable-next-line
var tools = [
  new Tool({
    name: 'npm',
    cmd: 'list',
    parse: function (out) {
      return out.cache
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
    cmd: 'current',
    parse: function (out) {
      return parse(out.data).cacheFolder
    },
    dive: function (dir) {
      var match = dir.match(/npm-(.+)-(\d+\.\d+\.\d+.*)-[\da-f]{40}$/)
      if (match) {
        add(match[1], match[2], this.path + '/' + dir + '.yarn-tarball.tgz')
      }
    }
  })
]

function Tool (options) {
  var self = this
  for (var key in options) self[key] = options[key]
  wait++
  exec(self.name + ' config ' + self.cmd + ' --json', function (ignore, out) {
    self.path = self.parse(parse(out))
    list(self.path, function (name) {
      self.dive(name)
    })
    unwait()
  })
}

function parse (json) {
  try {
    return JSON.parse(json)
  } catch (ignore) {
    return {}
  }
}

function list (dir, fn) {
  wait++
  fs.readdir(dir, function (err, files) {
    if (!err) files.forEach(fn)
    unwait()
  })
}

function add (name, v, path) {
  var versions = map[name] = map[name] || {}
  if (!versions[v]) {
    versions[v] = path
    count++
  }
}

function unwait () {
  if (!--wait) finish()
}

function finish () {
  if (!finishedCount) {
    log('Found ' + count + ' versions.')
    finishedCount = count
  }
}

function listen () {
  http.createServer(function (req, res) {
    if (req.url === '/') {
      var out = {}
      for (var name in map) {
        out[name] = Object.keys(map[name])
      }
      res.send(out)
    } else if (req.url === '/up') {
      res.send(true)
    }
  }).listen(port)
  log('Listening (http://' + ip + ':' + port + ').')
}

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
