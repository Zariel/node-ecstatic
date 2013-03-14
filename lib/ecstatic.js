#! /usr/bin/env node

var path = require('path'),
    fs = require('fs'),
    url = require('url'),
    mime = require('mime'),
    zlib = require('zlib'),
    showDir = require('./ecstatic/showdir'),
    version = JSON.parse(
      fs.readFileSync(__dirname + '/../package.json').toString()
    ).version,
    status = require('./ecstatic/status-handlers'),
    etag = require('./ecstatic/etag'),
    optsParser = require('./ecstatic/opts');

var fileCache = {};

var ecstatic = module.exports = function (dir, options) {
  if (typeof dir !== 'string') {
    options = dir;
    dir = options.root;
  }

  var root = path.join(path.resolve(dir), '/'),
      opts = optsParser(options),
      cache = opts.cache,
      autoIndex = opts.autoIndex,
      baseDir = opts.baseDir,
      defaultExt = opts.defaultExt;

  opts.root = dir;

  return function middleware (req, res, next) {

    // Figure out the path for the file from the given url
    var parsed = url.parse(req.url),
        pathname = decodeURI(parsed.pathname),
        file = path.normalize(
          path.join(root,
            path.relative(
              path.join('/', baseDir),
              pathname
            )
          )
        ),
        gzipped = file + '.gz';

    // Set common headers.
    res.setHeader('server', 'ecstatic-'+version);

    // TODO: This check is broken, which causes the 403 on the
    // expected 404.
    if (file.slice(0, root.length) !== root) {
      return status[403](res, next);
    }

    if (req.method && (req.method !== 'GET' && req.method !== 'HEAD' )) {
      return status[405](res, next);
    }

	var statFunc = function (err, stat) {
      if (err && err.code === 'ENOENT') {
        if (req.statusCode == 404) {
          // This means we're already trying ./404.html
          status[404](res, next);
        }
        else if (defaultExt && !path.extname(req.url).length) {
          //
          // If no file extension is specified and there is a default extension
          // try that before rendering 404.html.
          //
          middleware({
            url: req.url + '.' + defaultExt
          }, res, next);
        }
        else {
          // Try for ./404.html
          middleware({
            url: '/' + path.join(baseDir, '404.html'),
            statusCode: 404 // Override the response status code
          }, res, next);
        }
      }
      else if (err) {
        status[500](res, next, { error: err });
      }
      else if (stat.isDirectory()) {
        // 302 to / if necessary
        if (!pathname.match(/\/$/)) {
          res.statusCode = 302;
          res.setHeader('location', pathname + '/');
          return res.end();
        }

        if (autoIndex) {
          return middleware({
            url: path.join(pathname, '/index.html')
          }, res, function (err) {
            if (err) {
              return status[500](res, next, { error: err });
            }
            if (opts.showDir) {
              return showDir(opts, stat)(req, res);
            }

            return status[403](res, next);
          });
        }

        if (opts.showDir) {
          return showDir(opts, stat)(req, res);
        }

        status[404](res, next);

      }
      else {
        serve(stat);
      }
    };

    fs.stat(file, statFunc);

    function serve(stat) {
      // TODO: Helper for this, with default headers.
      var _etag = etag(stat);
      res.setHeader('etag', _etag);
      res.setHeader('last-modified', (new Date(stat.mtime)).toUTCString());
      res.setHeader('cache-control', 'max-age='+cache);

      // Return a 304 if necessary
      if (req.headers &&
          ((req.headers['if-none-match'] === _etag) ||
           (Date.parse(req.headers['if-modified-since']) >= stat.mtime)
        )
      ) {
        return status[304](res, next);
      }

      res.setHeader('content-length', stat.size);

      var contentType = mime.lookup(file), charSet;

      if (contentType) {
        charSet = mime.charsets.lookup(contentType);
        if (charSet) {
          contentType += '; charset=' + charSet;
        }
      }

      res.setHeader('content-type', contentType || 'application/octet-stream');

      if (req.method === "HEAD") {
        res.statusCode = req.statusCode || 200; // overridden for 404's
        return res.end();
      }

      var gziped = opts.gzip && shouldCompress(req);
      if (gziped) {
        res.setHeader('Content-Encoding', 'gzip');
        res.removeHeader('content-length');
      }

      var cached;
      if((cached = fileCache[file]) !== undefined) {
        // do we need to re-cache? ie file changed
        if(cached.etag === _etag) {
          // return from cache
          res.statusCode = 200;
          res.write(cached.buf);
          res.end();

          return;
        }
      }

      var writeOutCache = function(err, data) {
          if (err) {
            return status['500'](res, next, { error: err });
          }

          res.statusCode = 200;
          res.write(data);
          res.end();

          fileCache[file] = {
            etag: _etag,
            buf: data
          };
      };

      fs.readFile(file, function(err, data) {
        if (gziped) {
          zlib.gzip(data, writeOutCache);
        } else {
          writeOutCache(err, data);
        }
      });
    }
  };
};

ecstatic.version = version;
ecstatic.showDir = showDir;

// Check to see if we should try to compress a file with gzip.
function shouldCompress(req) {
  var headers = req.headers;

  return headers && headers['accept-encoding'] &&
    headers['accept-encoding'].indexOf('gzip') >= 0;
};

if(!module.parent) {
  var http = require('http'), 
      opts = require('optimist').argv,
      port = opts.port || opts.p || 8000,
      dir = opts.root || opts._[0] || process.cwd();

  if(opts.help || opts.h) {
    var u = console.error
    u('usage: ecstatic [dir] {options} --port PORT')
    u('see https://npm.im/ecstatic for more docs')
    return
  }
 
  http.createServer(ecstatic(dir, opts))
    .listen(port, function () {
      console.log('ecstatic serving ' + dir + ' on port ' + port);
    });
}
