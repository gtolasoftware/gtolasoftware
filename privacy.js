function onLoad() {
  var x = document.cookie;
  var shouldload=false;
  if(x && x.indexOf('consent')>-1) {
    shouldload=true;
  } else {
    var answer = window.confirm("Website uses cookies only for analytics. Consent?")
    if (answer) {
      document.cookie = "consent=true; expires=Fri, 31 Dec 2040 23:59:59 GMT; Secure";
      shouldload=true;
    } else {
      shouldload=false;
    }
  }
  if(shouldload) {
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-MCJPTVHDXQ');//UA-163584785-1
  }
}