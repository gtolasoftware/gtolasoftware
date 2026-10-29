(function() {
let CONSTS = { CARD_BADGE_REFRESH:3, APP_KEY:'95648c068f2561b7078eb48f7fef16ff', PAGESIZE:1000, RETURN_URL:'https://www.gtola.com/card-age/authorize.html', SCOPES:'read', APP_NAME:'Card Age for Trello',UNIT_HOURS:'hours',UNIT_DAYS:'days',UNIT_MINUTES:'minutes',SETTINGS:'CardAgeSettings', UNIT:'unit', REFRESH:'refresh', DECIMALPLACES:'decimalplaces', TOKEN:'token', EXCLUDELISTS:'excludelists', BADGECOLOR:'badgecolor' };
let SETTINGS = { debug:0 };
SETTINGS[CONSTS.UNIT]=CONSTS.UNIT_HOURS; 
SETTINGS[CONSTS.REFRESH]=3600; 
SETTINGS[CONSTS.DECIMALPLACES]=2; 
SETTINGS[CONSTS.EXCLUDELISTS]=''; 
SETTINGS[CONSTS.BADGECOLOR]='green'; 
let TIMES = {};
let BOARD_CARDS = {};
let PAGES = [];
let EXCLUDE_LISTS=[];
let LISTS={};
let TOKEN = null;
let PAGINATING = false;
let CANCEL_PAGINATION = false;
let SETTINGS_LOADED=false;
let REFRESH_INTERVAL=null;
let PREVIOUS_BOARD=null;
let UNIT_OF_MEASURE='h';
let EXPORT_INTERVAL=null;
let TIMES_READY=false;

function log(text) {
  if(SETTINGS.debug>0)
    console.log((new Date().toISOString())+' '+text);
}

function trySave(key, value, t, sharedOrPrivate) {
  return t.set('member', sharedOrPrivate, key, value)
    .catch(t.NotHandled, function(arg1) {
       log('Could not save key: '+key+', reason: '+arg1); 
    });
}

function tryLoad(key, t, sharedOrPrivate) {
  return t.get('member', sharedOrPrivate, key)
    .catch(t.NotHandled, function(arg1) {
       log('Could not load key: '+key+', reason: '+arg1); 
    });
}

function tryRemove(key, t, sharedOrPrivate) {
  return t.remove('member', sharedOrPrivate, key).catch(t.NotHandled, function(arg1){
     log('Could not remove key: '+key+', reason: '+arg1); 
  });
}

function request(method,url,params,callbackSuccess,callbackError,retryCount) {
  let httpRequest = new XMLHttpRequest();
  httpRequest.onreadystatechange = function() {
    if (httpRequest.readyState === XMLHttpRequest.DONE) {
      if (httpRequest.status === 200) {
        callbackSuccess(JSON.parse(httpRequest.responseText));
      } else {
        if(httpRequest.status === 429 || httpRequest.status === 504) {
          log('Retrying');
          setTimout(function() { request(method,url,params,callbackSuccess,callbackError,retryCount ? retryCount+1 : 1); },5000);
        }
        log(method+' '+url+' request failed. Status: '+httpRequest.status+', response: '+httpRequest.responseText);
        callbackError(httpRequest);
      }
    }
  };
  httpRequest.open(method,'https://api.trello.com/1' + url + (url.includes('?') ? '&' : '?') + 'key='+CONSTS.APP_KEY+'&token='+TOKEN);
  httpRequest.send();
}
    
function updateSettings(settings) {
  let keyValues = settings.split('\n');
  for(let i=0;i<keyValues.length; i++) {
    let keyValuesSplit = keyValues[i].split('=');
    SETTINGS[keyValuesSplit[0]] = Number.isInteger(SETTINGS[keyValuesSplit[0]]) ? parseInt(keyValuesSplit[1]) : keyValuesSplit[1];
  }
  log('Loaded settings: '+settings);
}

function serializeSettings() {
  let serialized='';
  for (let property in SETTINGS) {
    if(serialized!=='')
      serialized+='\n';
    serialized+=property+'='+SETTINGS[property];
  }
  return serialized;
}

function loadSettings(t) {
  tryLoad(CONSTS.SETTINGS,t,'shared').then(function(data) { 
    if(data) { 
      updateSettings(data);
      
      if(SETTINGS[CONSTS.UNIT]===CONSTS.UNIT_DAYS)
        UNIT_OF_MEASURE='d';
      else if(SETTINGS[CONSTS.UNIT]===CONSTS.UNIT_MINUTES)
        UNIT_OF_MEASURE='m';
      
      if(SETTINGS[CONSTS.EXCLUDELISTS]!=='') {
        EXCLUDE_LISTS = SETTINGS[CONSTS.EXCLUDELISTS].split(",");
      }
      
    } else {  
      trySave(CONSTS.SETTINGS, serializeSettings(), t,'shared');
    } 
  });
}

window.TrelloPowerUp.initialize({
  'remove-data': function(t) {
    log("remove-data");
    return tryRemove(CONSTS.TOKEN,t,'private').then(tryRemove(CONSTS.SETTINGS,t,'shared'));
  }, 
  'authorization-status': function(t, options){
    log("authorization-status");  
    return tryLoad(CONSTS.TOKEN,t,'private').then(function (data) {
      if(data) 
        return { authorized: true };
      else 
        return { authorized: false };
    });   
  },
  'show-authorization': function(t, options){
    log("show-authorization");
  
    let oauthUrl = 'https://trello.com/1/authorize?expiration=never' +
      '&name='+CONSTS.APP_NAME+'&scope='+CONSTS.SCOPES+'&key='+CONSTS.APP_KEY+'&callback_method=fragment' +
      '&return_url='+encodeURIComponent(CONSTS.RETURN_URL);
    log('Authorize url: '+oauthUrl);

    let tokenLooksValid = function(token) {
      //return /^[0-9a-f]{64}$/.test(token);
      log('Authorization successful. Redirecting to board: '+ t.getContext().board);
      //log(token);
      trySave(CONSTS.TOKEN,token,t,'private');
      t.navigate({
        url: 'https://trello.com/b/'+t.getContext().board
      });
    }

    let authorizeOpts = {
      height: 680,
      width: 580,
      validToken: tokenLooksValid
    };
    
    return t.popup({ title: 'c', url: './authorize.html', height: 1 }).then(function(aaa) { 
      t.closePopup();
      t.authorize(oauthUrl, authorizeOpts);
      // t.authorize(oauthUrl, authorizeOpts).then(function(token) { 
      //   log('Authorization successful. Redirecting to board: '+ t.getContext().board);
      //   trySave(CONSTS.TOKEN,token,t,'private');
      //   t.navigate({
      //     url: 'https://trello.com/b/'+t.getContext().board
      //   });
      // });
    })

  },
  'show-settings': function(t, options) {
    log("show-settings");
    return t.popup({
      title: 'Settings',
      url: './settings.html',
      height: 500
    });
  }, 

  "card-badges": function (ttt, opts2) {
    log("card-badges");
    
    if(!SETTINGS_LOADED) {
      loadSettings(ttt);                   
      SETTINGS_LOADED=true;
    }
    
    if(!TOKEN)
      tryLoad(CONSTS.TOKEN,ttt,'private').then(function(data) { 
        if(data) {
          TOKEN=data;
        } else {
          log('Undefined token loaded from member private space');
          ttt.alert({message: 'Please go to Card Age for Trello Settings and then Authorize to start showing card age'});
          return null;
        }
      });
      
    ttt.lists("id","name").then(function (list) {
      for(let i=0;i<list.length;i++)
        LISTS[list[i].name.toLowerCase()]=list[i].id;
    });
    
    return ttt
      .card('all')
      .then(function (arg1, arg2) {
          return [
          {
            dynamic: function (arg11, arg22) {    
              if(!TOKEN)
                return {text: null, color: null, refresh: CONSTS.CARD_BADGE_REFRESH};
              for(let i=0;i<EXCLUDE_LISTS.length;i++)
                if(arg1.idList===LISTS[EXCLUDE_LISTS[i].toLowerCase().trim()])
                   return {text: null, color: null, refresh: CONSTS.CARD_BADGE_REFRESH};
            
              let cardId = arg1.id;
              let metric = 1000 * 60 * 60;
              if(SETTINGS[CONSTS.UNIT]===CONSTS.UNIT_HOURS)
                 metric = 1000 * 60 * 60;
              else if(SETTINGS[CONSTS.UNIT]===CONSTS.UNIT_DAYS)
                metric = 1000 * 60 * 60 * 24;
              else if(SETTINGS[CONSTS.UNIT]===CONSTS.UNIT_MINUTES)
                metric = 1000 * 60;
              let tmpTime = ((new Date() - new Date(1000*parseInt(cardId.substring(0,8),16)))/metric).toFixed(SETTINGS[CONSTS.DECIMALPLACES]);
              tmpTime=Math.abs(tmpTime)+UNIT_OF_MEASURE;
              let badgeResult = {text: tmpTime, refresh: CONSTS.CARD_BADGE_REFRESH};
              if(SETTINGS[CONSTS.BADGECOLOR]!=='none')
                badgeResult['color']=SETTINGS[CONSTS.BADGECOLOR];

              return badgeResult;
            },
          }
        ];     
      });    
  },
}, {
  appKey: CONSTS.APP_KEY,
  appName: CONSTS.APP_NAME,
  helpfulStacks: SETTINGS.debug > 0
});


})();