/*
 * Provides time-based promise-returning delay and schedule functions
 */
var defer = require("./promise").defer,
    LazyArray = require("./lazy-array").LazyArray,
    EventLoop = require("event-loop");
// returns a promise that is fulfilled after the given number of milliseconds
exports.delay = function(ms){
    var deferred = defer();
    EventLoop.setTimeout(deferred.resolve, ms);
    return deferred.promise;
};
// returns a lazy array that iterates one every given number of milliseconds
exports.schedule = function(ms){
    var callbacks = [];
    EventLoop.setInterval(function(){
        callbacks.forEach(function(callback){
            if(callback()){
                callbacks.splice(callbacks.indexOf(callback), 1);
            }
        });
    }, ms);
    return LazyArray({
        some: function(callback){
            callbacks.push(callback);
        }
    });
};
