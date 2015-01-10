'use strict';

var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);

var EventEmitter = require('events').EventEmitter;
var client = require('mongodb').MongoClient;

function Chat() {
  this.db = null;
  this.coll = null;
}

Chat.prototype.setUpMongo = function(url, collectionName, filter, callback) {
  var proxy = new EventEmitter();
  var self = this;
  
  // connection to mongo
  client.connect(url, function(err, db) {
    if (err) return callback(err);

    self.db = db;

    // create a capped collection
    db.createCollection(collectionName, {capped: true, size: 4096}, function(err) {
      if (err) return callback(err);

      // get collection
      db.collection(collectionName, function(err, coll) {
        if (err) return callback(err);

        self.coll = coll;
   
        // go to the end of the capped collection
        var seekCursor = coll.find(filter).sort({$natural: -1}).limit(1);
        seekCursor.nextObject(function(err, latest) {
          if (err) return callback(err);

          if (latest) {
            filter._id = { $gt: latest._id }
          }
          
          var cursorOptions = {
            tailable: true,
            awaitdata: true,
            numberOfRetries: -1
          };
          // create the stream with the correct options
          var stream = coll.find(filter, cursorOptions).sort({$natural: -1}).stream();
          
          // on new document proxy emits 'log-comming' event
          stream.on('data', proxy.emit.bind(proxy, 'log-comming'));
          // on error proxy emits 'error' event
          stream.on('error', proxy.emit.bind(proxy, 'error'));

          // when a 'write-log' event coll inserts the new message
          proxy.on('write-log', function(message) {
            coll.insert(message, function(err) {
              console.log('written log on db. err:', err);
            });
          });

          callback(null, proxy);
        });
      });
    });
  });
}

// get lastest messages
Chat.prototype.getAllMessages = function(callback) {
  this.coll.find({}).sort({$natural: -1}).limit(5).toArray(callback);
};


var chat = new Chat();
// after setup
chat.setUpMongo('mongodb://localhost/test', 'log', {}, function(err, proxy) {
  if (err) throw err;

  // on new socket arrives
  io.on('connection', function(socket) {
    console.log('User connected');

    // send back all lastest messages
    chat.getAllMessages(function(err, messages) {
      if (err) throw err;

      messages.reverse();
      for (var i in messages) {
        socket.emit('chat message', messages[i]);
      }
    });

    // when the client send a message in 'chat message' chat
    socket.on('chat message', function(log) {
      var message = {
        text: log,
        create: new Date(),
      }
      // this writes the message on db
      proxy.emit('write-log', message);
    });
  });

  // this is called when a new message is written on db
  proxy.on('log-comming', function(message) {
    console.log('log-comming', message)
    // emit to everyone the message
    io.emit('chat message', message);
  });

  // serve the index.html file
  app.get('/', function(req, res){
    res.sendfile('index.html');
  });
  http.listen(3000, function(){
    console.log('listening on *:3000');
  });
});
