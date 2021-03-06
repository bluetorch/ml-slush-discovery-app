/* global MLSearchController */
(function() {
    'use strict';

    angular.module('app.search')
        .controller('SearchCtrl', SearchCtrl);

    SearchCtrl.$inject = [
        '$scope', '$location', '$window', '$filter', '$timeout',
        'userService', 'MLSearchFactory', 'RegisteredComponents',
        'ServerConfig', 'MLQueryBuilder', 'constraints', 'MLRest'
    ];

    // inherit from MLSearchController
    var superCtrl = MLSearchController.prototype;
    SearchCtrl.prototype = Object.create(superCtrl);

    function SearchCtrl(
        $scope, $location, $window, $filter, $timeout,
        userService, searchFactory,
        RegisteredComponents, ServerConfig, qb, constraints, mlRest
    ) {
        var ctrl = this;
        var mlSearch = searchFactory.newContext({
            searchTransform: 'extract-json',
            queryOptions: 'all'
        });

        ctrl.sort = [];

        mlSearch.setTransform('extract-json');

        ctrl.pageExtensions = RegisteredComponents.pageExtensions();

        ctrl.hasPageExtensions = false;

        $scope.$watch(function() {
            return _.filter(ctrl.pageExtensions, function(val) {
                return val.active;
            }).length;
        }, function(newVal) {
            ctrl.hasPageExtensions = newVal > 0;
        });

        $scope.decodeURIComponent = $window.decodeURIComponent;

        ServerConfig.getCharts().then(function(chartData) {
            ctrl.charts = chartData.charts;
        });

        ctrl.setSnippet = function(type) {
            mlSearch.setSnippet(type);
            ctrl.search();
        };

        ctrl.setSort = function(type) {
            mlSearch.setSort(type);
            ctrl.search();
        };

        ctrl.showMoreFacets = function(facet, facetName) {
            mlSearch.showMoreFacets(facet, facetName);
        };

        $scope.$watch(userService.currentUser, function(newValue) {
            ctrl.currentUser = newValue;
        });

        /* BEGIN Date/DateTime constraint logic */
        ctrl.dateFilters = {};
        ctrl.dateStartOpened = {};
        ctrl.dateEndOpened = {};
        ctrl.pickerDateStart = {};
        ctrl.pickerDateEnd = {};
        ctrl.dateTimeConstraints = {};
        ctrl.datePickerOptions = {
            minDate: new Date(1900, 1, 1),
            maxDate: new Date(2050, 12, 31)
        };

        mlSearch.getStoredOptions().then(function(data) {
            ctrl.queryOptions = angular.copy(data.options);
            ctrl.sortOptions = (_.filter(
                data.options.operator,
                function(val) {
                    return val.name === 'sort';
                }
            )[0] || {
                state: []
            }).state;

            angular.forEach(data.options.constraint, function(constraint) {
                if (constraint.range && (constraint.range.type === 'xs:date' ||
                    constraint.range.type === 'xs:dateTime')) {
                    ctrl.dateTimeConstraints[constraint.name] = {
                        name: constraint.name,
                        type: constraint.range.type
                    };
                }
            });

            MLSearchController.call(ctrl, $scope, $location, mlSearch);

            ctrl.init();
            //ctrl.constraints = ctrl.getConstraints();
        });

        // implement superCtrl extension method
        ctrl.parseExtraURLParams = function() {
            var foundExtra = false;
            ctrl.pickerDateStart = {};
            ctrl.pickerDateEnd = {};
            angular.forEach($location.search(), function(val, key) {
                var constraintName;
                if (key.indexOf('startDate:') === 0) {
                    constraintName = key.substr(10);
                    ctrl.pickerDateStart[constraintName] = new Date(val);
                    ctrl._applyDateFilter(constraintName);
                    foundExtra = true;
                } else if (key.indexOf('endDate:') === 0) {
                    constraintName = key.substr(8);
                    ctrl.pickerDateEnd[constraintName] = new Date(val);
                    ctrl._applyDateFilter(constraintName);
                    foundExtra = true;
                }
            });
            if ($location.search().s) {
                foundExtra = true;
                mlSearch.setSort($location.search().s);
            }
            return foundExtra;
        };

        ctrl.toggleSort = function(constraint) {
            var found = $filter('filter')(ctrl.sort, {
                    name: constraint
                }),
                dir = 'ascending',
                idx = -1;
            if (found.length > 0) {
                idx = ctrl.sort.indexOf(found[0]);
                if (idx > -1) {
                    ctrl.sort.splice(idx, 1);
                }
                if (found[0].direction === 'ascending') {
                    dir = 'descending';
                } else if (found[0].direction === 'descending') {
                    dir = null;
                }
            }
            if (dir !== null) {
                ctrl.sort.unshift({
                    name: constraint,
                    direction: dir
                });
            }
            ctrl.search();

        };

        // implement superCtrl extension method
        ctrl.updateExtraURLParams = function() {
            angular.forEach(ctrl.pickerDateStart, function(val, key) {
                $location.search('startDate:' + key, _constraintToDateTime(key, val));
            });
            angular.forEach(ctrl.pickerDateEnd, function(val, key) {
                $location.search('endDate:' + key, _constraintToDateTime(key, val));
            });
            angular.forEach($location.search(), function(val, key) {
                if ((key.indexOf('startDate:') === 0 && !ctrl.pickerDateStart[key.substr(10)]) ||
                    (key.indexOf('endDate:') === 0 && !ctrl.pickerDateEnd[key.substr(8)])) {
                    $location.search(key, null);
                }
            });
        };

        ctrl._search = function() {
            this.searchPending = true;
            this.updateURLParams();
            ctrl.mlSearch.clearAdditionalQueries();
            for (var key in ctrl.dateFilters) {
                if (ctrl.dateFilters[key] && ctrl.dateFilters[key].length) {
                    mlSearch.addAdditionalQuery(
                        qb.and(
                            ctrl.dateFilters[key]
                        )
                    );
                }
            }

            var params = {
                start: mlSearch.start,
                pageLength: mlSearch.getPageLength(),
                transform: mlSearch.getTransform(),
                options: mlSearch.getQueryOptions(),
            };

            var combined = mlSearch.getCombinedQuerySync();

            if (combined.search.options !== undefined && ctrl.sort.length > 0) {
                delete combined.search.options['sort-order'];
            } else if (ctrl.sort.length > 0) {
              combined.search.options = { 'sort-order': []};
            }

            if (ctrl.sort.length > 0) {
              console.log("Current sort: ", ctrl.sort);
              var constraint;
              ctrl.sort.forEach(function(item) {
                constraint = $filter('filter')(ctrl.queryOptions.constraint, { name: item.name });
                if (constraint.length > 0) {
                  combined.search.options['sort-order'].push({
                    direction: item.direction,
                    element: constraint[0].range.element,
                    attribute: constraint[0].range.attribute,
                    field: constraint[0].range.field,
                    'json-property': constraint[0].range['json-property']
                  });
                }
              });
            }

            ctrl.combinedQuery = null;
            $timeout(function() {
              ctrl.combinedQuery = combined.search;
            });
            return mlRest.search(params, combined)
                .then(function(response) {
                    var results = response.data;

                    mlSearch.transformMetadata(results.results);
                    mlSearch.annotateActiveFacets(results.facets);

                    return results;
                })
                .then(this.updateSearchResults.bind(this));

        };

        ctrl.openStartDatePicker = function(constraintName, $event) {
            $event.preventDefault();
            $event.stopPropagation();
            ctrl.dateStartOpened[constraintName] = true;
        };

        ctrl.openEndDatePicker = function(constraintName, $event) {
            $event.preventDefault();
            $event.stopPropagation();
            ctrl.dateEndOpened[constraintName] = true;
        };

        ctrl._applyDateFilter = function(constraintName) {
            ctrl.dateFilters[constraintName] = [];
            if (ctrl.pickerDateStart[constraintName] && ctrl.pickerDateStart[constraintName] !== '') {
                var startValue =
                    _constraintToDateTime(constraintName, ctrl.pickerDateStart[constraintName]);
                ctrl.dateFilters[constraintName]
                    .push(qb.ext.rangeConstraint(constraintName, 'GE', startValue));
            }
            if (ctrl.pickerDateEnd[constraintName] && ctrl.pickerDateEnd[constraintName] !== '') {
                var endValue = _constraintToDateTime(constraintName, ctrl.pickerDateEnd[constraintName]);
                ctrl.dateFilters[constraintName]
                    .push(qb.ext.rangeConstraint(constraintName, 'LE', endValue));
            }
        };

        ctrl.applyDateFilter = function(constraintName) {
            ctrl._applyDateFilter(constraintName);
            ctrl.search();
        };

        ctrl.clearDateFilter = function(constraintName) {
            ctrl.dateFilters[constraintName].length = 0;
            ctrl.pickerDateStart[constraintName] = null;
            ctrl.pickerDateEnd[constraintName] = null;
            ctrl.search();
        };

        ctrl.dateOptions = {
            formatYear: 'yy',
            startingDay: 1
        };

        function _constraintToDateTime(constraintName, dateObj) {
            var constraintType = ctrl.dateTimeConstraints[constraintName].type;
            if (dateObj) {
                var dateISO = dateObj.toISOString();
                var dateValue = dateISO;
                if (constraintType === 'xs:date') {
                    dateValue = dateISO.substr(0, dateISO.indexOf('T')) + '-06:00';
                }
                return dateValue;
            } else {
                return null;
            }
        }
        /* END Date/DateTime constraint logic */

        function isFacetConstraint(constraintName) {
            return constraintName && constraintName !== '$frequency';
        }

        ctrl.chartItemSelected = function(chart, name, xCategory, x, y, z, seriesName) {
            if (isFacetConstraint(chart.xAxisCategoriesMLConstraint)) {
                ctrl.mlSearch.toggleFacet(chart.xAxisCategoriesMLConstraint, xCategory);
            } else if (isFacetConstraint(chart.xAxisMLConstraint)) {
                ctrl.mlSearch.toggleFacet(chart.yAxisMLConstraint, x);
            } else if (isFacetConstraint(chart.yAxisMLConstraint)) {
                ctrl.mlSearch.toggleFacet(chart.yAxisMLConstraint, y);
            } else if (isFacetConstraint(chart.zAxisMLConstraint)) {
                ctrl.mlSearch.toggleFacet(chart.zAxisMLConstraint, z);
            } else if (isFacetConstraint(chart.seriesNameMLConstraint)) {
                ctrl.mlSearch.toggleFacet(chart.seriesNameMLConstraint, seriesName);
            } else if (isFacetConstraint(chart.dataPointNameMLConstraint)) {
                ctrl.mlSearch.toggleFacet(chart.dataPointNameMLConstraint, name);
            }
            ctrl.search();
        };

        ctrl.updateSearchResults = function updateSearchResults(data) {
            if (arguments[0] && arguments[0].results) {
                arguments[0].results[0].constraints = constraints;
                arguments[0].results.forEach(function(result) {
                    if (result.extracted && result.extracted.content[0]) {
                        result.extracted.merged = {};
                        result.extracted.content.forEach(function(content) {
                            for (var property in content) {
                                if (content.hasOwnProperty(property)) {
                                    result.extracted.merged[property] = content[property];
                                }
                            }
                            //Object.assign(result.extracted.merged, content.enrichment);
                        });
                    }
                });
            }
            superCtrl.updateSearchResults.apply(ctrl, arguments);
        };

        $scope.$on('sort', function(event, constraint) {
            ctrl.toggleSort(constraint);
        });

    }
}());
