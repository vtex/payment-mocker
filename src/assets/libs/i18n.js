var languages = Array.from(document.getElementsByClassName('language'));
var xhttp = new XMLHttpRequest();
var langDocument = {};
languages.forEach(function(value, index){
    languages[index].addEventListener('click', function(){
        switchLanguage(this.dataset.lang);
    });
});
xhttp.onreadystatechange = function(){
    if (this.readyState === 4 && this.status === 200) {
        langDocument = JSON.parse(this.responseText);
        processLangDocument();
    }
};
function switchLanguage(language){
    xhttp.open('GET', `i18n/${language}.json`, true);
    xhttp.setRequestHeader('Content-type', 'application/json');
    xhttp.send();
}
function processLangDocument(){
    var paymentGroupLabel = Array.from(document.getElementById('payment-group-safetypayPaymentGroup').querySelectorAll('a,span'))[0];
    var template = document.getElementsByClassName('payment-mocker-template');
    var tags = Array.from(template[0].querySelectorAll('div,span,img,a,p,label,li,option,h1,h2,h3,h4,h5,h6'));

    tags.push(paymentGroupLabel)
    tags.forEach(function(value, index){
        var key = value.dataset.i18n;
        if(langDocument[key]) value.innerText = langDocument[key];
    });
}
