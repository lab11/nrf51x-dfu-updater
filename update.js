var noble = require('noble');
var argv = require('minimist')(process.argv.slice(2));
var fs = require('fs');
var async = require('async');
var progress = require('progress');
var binary = require('./binary.js')

var DFU_SERVICE     = '000015301212efde1523785feabcd123' 
var DFU_CTRLPT_CHAR   = '000015311212efde1523785feabcd123' 
var DFU_PKT_CHAR = '000015321212efde1523785feabcd123' 
var ATT_MTU = 23;

if (!argv.f || !argv.b) {
  printHelp();
}
var mac = argv.b.match(/[0-9a-fA-F][^:]/g).join('').toLowerCase();
if (mac.length != 12) {
  console.log('invalid ble address');
  printHelp();
}

// Updater handles the actual upload
var updater = new Updater(mac, argv.f);

function Updater(mac, fname) {

  var self = this;
  
  this.fileBuffer = null;
  this.targetMAC = mac;
  this.targetDevice = null;
  this.initPkt = null;
  this.targetIsApp = 0;
  this.ctrlptChar = null;
  this.pktChar = null;
  this.progressBar = null;

  async.series([
    // read firmware bin file and prepare related parameters
    function(callback) {
      fs.readFile(fname, function(err, data) {
        self.fileBuffer = data;
        self.initPkt = initPacket(self.fileBuffer); 
        callback(err, data);
      });
    },
    function(callback) {
      // start scanning BLE devices
      noble.on('stateChange', function(state) {
        if (state === 'poweredOn') {
          console.log('starting scan...');
          noble.startScanning([], true);
        } else {
          noble.stopScanning();
        }
        callback(null, 2);
      });
    },
    function(callback) {
      // when we discover devices
      noble.on('discover', discoverDevice);
      callback(null, 3);
    }
  ],
  function(err, results) {
    if (err) throw err;
  });
  
  // when a scan discovers a device, check if its MAC matches 
  function discoverDevice(peripheral) {
    //console.log('discovered device: ' + peripheralToString(peripheral));
    if (peripheral.id == self.targetMAC) {
      noble.stopScanning();
      console.log('found requested peripheral: ' + peripheralToString(peripheral)); 
      self.targetDevice = peripheral;
      self.targetDevice.once('disconnect', function() {
        console.log('disconnected from ' + peripheralToString(peripheral));
        if (!self.targetIsApp) process.exit(); 
        else noble.startScanning([], true);
      });
      dfuStart();
    }
  }

  function ctrlNotify(data, isNotify) {
    if(data.length !== 3) {
      console.log("Bad length from target: " + data.length);
      return;
    }
    if(data[0] !== 16) {
      console.log("Bad opcode from target: 0x" + data[0].toString(16));
      return;
    }
    if(data[2] !== 1) {
      console.log("Bad respvalue from target: 0x" + data[2].toString(16));
      return;
    }
    // Got a good response, now finish DFU process
    switch(data[1]) {
      case 1:
        async.series([
          // Initialize DFU Parameters (write 0x02 to DFU Control Point)
          function(callback) {
            self.ctrlptChar.write(Buffer([0x02, 0x00]), false, function(err) {
              console.log('Init DFU Parameters');
              callback(err, 1); 
            });
          },
          // Send Init Packet
          function(callback) {
            self.pktChar.write(self.initPkt, false, function(err) {
              console.log('Sent DFU Parameters');
              callback(err, 1);
            });
          },
          // Initialize DFU Parameters (write 0x02 to DFU Control Point)
          function(callback) {
            self.ctrlptChar.write(Buffer([0x02, 0x01]), false, function(err) {
              console.log('Finish DFU Parameters');
              callback(err, 1); 
            });
          }],
          function(err, results) {
            if (err) throw err;
      }); 
      break;
    case 2:
      // Send FW Image (write 0x03 to DFU Control Point)
      async.series([
      function(callback) {
        self.ctrlptChar.write(Buffer([0x03]), false, function(err) {
          callback(err, 1);
        });
      },
      // Send FW Image packets
      function(callback0) {
        self.progressBar = new progress('downloading [:bar] :percent :etas', {
          complete: '=',
          incomplete: ' ',
          width: 40,
          total: self.fileBuffer.length/(ATT_MTU-3)
        });
        var i = 0;
        async.whilst(
          function(){
            return i < self.fileBuffer.length;
          },
          function(callback1) {
            var end = i+(ATT_MTU-3);
            if (end > self.fileBuffer.length) end = self.fileBuffer.length; 
            self.pktChar.write(self.fileBuffer.slice(i, end), false, function(err) {
              if (i/(ATT_MTU-3) % 10 == 0) {
                self.progressBar.tick(10);
              }
              i = end;
              callback1(err, i)
            });
          },
          function (err, i) {
            callback0(err, i);
          });
      }],
      function(err, results) {
        if (err) throw err;
      });
      break;
    case 3:
      // Validate FW image 
      self.ctrlptChar.write(Buffer([0x04]), false, function(err) {
        console.log('Validate image');
      });
      break; 
    case 4:
      // Activate Image and reset 
      self.ctrlptChar.write(Buffer([0x05]), false, function(err) {
        console.log('Activate image');
      });
      break; 
    default:
      console.log('got unexpected reqopcode ' + data[1]);
      process.exit();
    }
  }

  function dfuStart() {
    async.series([
    // Connect to target
    function(callback) {
      self.targetDevice.connect(function(err) {
        console.log('connected to ' + peripheralToString(self.targetDevice));
        callback(err, 1);
      });
    },
    // Get DFU Service
    function(callback) {
      self.targetDevice.discoverServices([DFU_SERVICE], function(err, services) {
        self.dfuServ = services[0];
        callback(err, 1);
      });
    },
    // Get DFU ctrl Characteristic
    function(callback) {
      self.dfuServ.discoverCharacteristics([DFU_CTRLPT_CHAR],
        function (err, chars)
      {
        self.ctrlptChar = chars[0];
        self.ctrlptChar.notify(true);
        self.ctrlptChar.on('data', ctrlNotify); 
        callback(err, 1);
      });
    },
    // Get DFU pkt Characteristic
    function(callback) {
      self.dfuServ.discoverCharacteristics([DFU_PKT_CHAR],
        function (err, chars)
      {
        if (chars.length == 0) {
          // going from app to bootloader
          self.targetIsApp = 1;
          callback(err, 1);
        } else {
          self.pktChar = chars[0];
          self.targetIsApp = 0;
          callback(err, 0);
        }
      });
    },
    // Start DFU (write 0x01 to DFU Control Point)
    function(callback) {
      // TODO 0x04 should be optional 
      self.ctrlptChar.write(new Buffer([0x01, 0x04]), false, function(err) {
        if (self.targetIsApp) console.log("Resetting Target to Bootloader");
        else console.log("Starting DFU");
        callback(err, 1);
      });
    },
    // Send image size
    function(callback) {
      if (self.targetIsApp) return callback();
      var sizeBuf = new Buffer(12);
      sizeBuf.fill(0);
      // TODO allow softdevice and bootloader, maybe do this when fileBuffer filled
      sizeBuf[8] = binary.loUint16(binary.loUint32(self.fileBuffer.length));
      sizeBuf[9] = binary.hiUint16(binary.loUint32(self.fileBuffer.length));
      sizeBuf[10] = binary.loUint16(binary.hiUint32(self.fileBuffer.length));
      sizeBuf[11] = binary.hiUint16(binary.hiUint32(self.fileBuffer.length));
      
      self.pktChar.write(sizeBuf, false, function(err) {
        console.log('Send img size');
        callback(err, 5);
      });
    }],
    function(err, results) {
      if (err) throw err;
    }); 
  }
  
  function initPacket(data) {
    // calculate CRC:
    var crc = crc16(data); 
    console.log('image size ' + self.fileBuffer.length);
    console.log('calculated crc of firmware: 0x' + crc.toString(16)); 
    var packet = new Buffer(14);
    
    // TODO change to be an option
    // Device Type:
    packet[0]   = 0xFF;
    packet[1]   = 0xFF;
    // Device Revision:
    packet[2]   = 0xFF;
    packet[3]   = 0xFF;
    // Application Version:
    packet[4]   = 0xFF;
    packet[5]   = 0xFF;
    packet[6]   = 0xFF;
    packet[7]   = 0xFF;
    // Softdevice array length:
    packet[8]   = binary.loUint16(0x1);
    packet[9]   = binary.hiUint16(0x1);
    // Softdevice[1]:
    packet[10]  = binary.loUint16(0xFFFE);
    packet[11]  = binary.hiUint16(0xFFFE);
    // CRC16:
    packet[12]  = binary.loUint16(crc);
    packet[13]  = binary.hiUint16(crc);

    return packet; 
  }

  function crc16(data, start) {
    var crc = start || 0xFFFF;
    for(var i = 0; i < data.length; i++) {
      crc =  (crc >> 8) & 0xFF | (crc << 8);
      crc ^= data[i];
      crc ^= (crc & 0xFF) >> 4;
      crc ^= (crc << 8) << 4;
      crc ^= ((crc & 0xFF) << 4) << 1;
    }
    
    return crc & 0xFFFF;
  } 
}

function peripheralToString(peripheral) {
  return peripheral.id.match(/../g).join(':') + ' '
    + peripheral.advertisement.localName;
}

function printHelp() {
  console.log('-a provides device address in the form XX:XX:XX:XX:XX:XX');
  console.log('-f provides a required filename for firmware *.bin\n');
  process.exit();
};
