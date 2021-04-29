# VTEX Payment Mocker

A boilerplate to develop and test a Payment Method to VTEX Smart Checkout, based on [Pink](https://github.com/augustocb/pink).

We recommend you read the [Guide to Design a Payment Method to VTEX Smart Checkout](https://docs.google.com/document/d/16JVEF6I5brdUl_zHpE6kUriVKuigycVUNEt20iPyoNI/edit#heading=h.qytoq9cybc2s).

You can see an example of a Payment Method layout working in [http://vtex.github.io/checkout-payment-ui/](http://vtex.github.io/checkout-payment-ui/).

## Features

The main features:

*   Local server
*   Less autocompile
*   Livereload for any files changes
*   Base of VTEX Smart Checkout HTML and CSS
*   Internationalization for 4 idioms: FR, EN, PT-BR and ES

## How it works

When you run `grunt`, it starts a server at [http://localhost:8080/](http://localhost:8080/), compiles `style.less` file and begin watching changes in all files inside `assets` folder. Any change will reload the page or just reload css files, in case of style changes.

You can test your layout creating/modifying:

*   `src/partials/payment.html`: HTML file
*   `src/assets/css/less/style.less`: style file
*   `src/assets/img/`: images folder
*   `src/i18n`: internalization folder

## Dependencies

1.  [Node.js](http://nodejs.org/download)
2.  Grunt: run `sudo npm i -g grunt-cli`
3.  [Sass](http://sass-lang.com/install)

## Installation

1.  Download or clone this repo
2.  Install NPM dependencies: run `npm i`

## Hands on!

### Running

1.  Run `grunt`
2.  Go to [http://localhost:8080/](http://localhost:8080/)

## Thank you! :)
