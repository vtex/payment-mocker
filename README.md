# Pink

A simple front-end boilerplate for Interaction Designers and Developers.

## Features

The main features of Pink:

*   Local server
*   Less and Sass autocompile
*   Bootstrap Less files included for customization
*   Livereload for any files changes
*   [VTEX CSS Utils](https://github.com/vtex-apps/css-utils) styleguide FTW
*   _Build_ command for publishing filtered files
*   Front-end development frameworks included: jQuery, AngularJS, React, Underscore

## How it works

When you run `grunt`, Pink starts a server at [http://localhost:8080/](http://localhost:8080/), compiles `style.less` and `style.sass` files and begin watching changes in all files inside `assets` folder. Any change will reload the page or just reload css files, in case of style changes.

When you run `grunt build`, Pink makes a copy of `src` folder to `build` and removes `.less` and `.scss` files from the last one.

When you run `grunt dist`, Pink runs `grunt build` and publish it's content to `gh-pages` branch.

## Dependencies

1.  [Node.js](http://nodejs.org/download)
2.  Grunt: run `sudo npm i -g grunt-cli`
3.  [Sass](http://sass-lang.com/install)

## Installation

1.  Download or clone Pink
2.  Install NPM dependencies: run `npm i`

## Hands on!

### Running Pink

1.  Run `grunt`
2.  Go to [http://localhost:8080/](http://localhost:8080/)

### Generating a new bootstrap.css file

If you make changes on bootstrap.less file, you'll need to run this:

````
grunt less:bootstrap
````

### Generating a Build folder

````
grunt build
````

### Publishing to gh-pages branch

````
grunt dist
````

## Thank you! :)
