(function(angular) {
	'use strict';

	console.log('AngularJS is working!');

	var pink = angular.module('pinkModule', []);

	pink.controller('bandController', ['$scope', '$http', '$timeout', function($scope, $http, $timeout) {
		$scope.band = [];

		$http.get('./assets/data/band.json').then(function(response) {
			$scope.band = response.data;
		});

  }]);
})(window.angular);
