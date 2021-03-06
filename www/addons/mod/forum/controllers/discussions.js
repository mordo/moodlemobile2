// (C) Copyright 2015 Martin Dougiamas
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

angular.module('mm.addons.mod_forum')

/**
 * Forum discussion list controller.
 *
 * @module mm.addons.mod_forum
 * @ngdoc controller
 * @name mmaModForumDiscussionsCtrl
 */
.controller('mmaModForumDiscussionsCtrl', function($q, $scope, $stateParams, $mmaModForum, $mmCourse, $mmUtil, $mmGroups, $mmUser,
            $mmEvents, $ionicScrollDelegate, $ionicPlatform, mmUserProfileState, mmaModForumNewDiscussionEvent, $mmSite, $translate,
            mmaModForumReplyDiscussionEvent, $mmText, mmaModForumComponent, $mmaModForumOffline, $mmaModForumSync,
            mmaModForumAutomSyncedEvent, mmaModForumManualSyncedEvent) {
    var module = $stateParams.module || {},
        courseid = $stateParams.courseid,
        forum,
        page = 0,
        scrollView,
        shouldScrollTop = false,
        usesGroups = false,
        obsNewDisc,
        obsReply;

    $scope.title = module.name;
    $scope.description = module.description;
    $scope.moduleUrl = module.url;
    $scope.moduleName = $mmCourse.translateModuleName('forum');
    $scope.courseid = courseid;
    $scope.userStateName = mmUserProfileState;
    $scope.isCreateEnabled = $mmaModForum.isCreateDiscussionEnabled();
    $scope.refreshIcon = 'spinner';
    $scope.component = mmaModForumComponent;
    $scope.componentId = module.id;

    // Convenience function to get forum data and discussions.
    function fetchForumDataAndDiscussions(refresh, sync) {
        return $mmaModForum.getForum(courseid, module.id).then(function(forumdata) {
            forum = forumdata;

            $scope.title = forum.name || $scope.title;
            $scope.description = forum.intro || $scope.description;
            $scope.forum = forum;

            if (sync) {
                // Try to synchronize the forum.
                return syncForum(false).catch(function() {
                    // Ignore errors.
                });
            }
        }).then(function() {
            return $mmGroups.getActivityGroupMode(forum.cmid).then(function(mode) {
                usesGroups = mode === $mmGroups.SEPARATEGROUPS || mode === $mmGroups.VISIBLEGROUPS;
            }).finally(function() {
                var promises = [];

                // Check if there are discussions stored in offline.
                promises.push($mmaModForumOffline.hasNewDiscussions(forum.id).then(function(hasOffline) {
                    $scope.hasOffline = hasOffline;

                    if (hasOffline) {
                        // Get offline discussions.
                        return $mmaModForumOffline.getNewDiscussions(forum.id).then(function(offlineDiscussions) {
                            var promise = usesGroups ?
                                $mmaModForum.formatDiscussionsGroups(forum.cmid, offlineDiscussions) : $q.when(offlineDiscussions);

                            return promise.then(function(offlineDiscussions) {
                                // Fill user data for Offline discussions (should be already cached).
                                var userPromises = [];
                                angular.forEach(offlineDiscussions, function(discussion) {
                                    userPromises.push($mmUser.getProfile(discussion.userid, courseid, true).then(function(user) {
                                        discussion.userfullname = user.fullname;
                                        discussion.userpictureurl = user.profileimageurl;
                                    }));
                                });

                                return $q.all(userPromises).then(function() {
                                    $scope.offlineDiscussions = offlineDiscussions;
                                });
                            });
                        });
                    } else {
                        $scope.offlineDiscussions = [];
                    }
                }));

                promises.push(fetchDiscussions(refresh));

                return $q.all(promises);
            });
        }).catch(function(message) {
            if (!refresh) {
                // Get forum failed, retry without using cache since it might be a new activity.
                return refreshData(sync);
            }

            if (message) {
                $mmUtil.showErrorModal(message);
            } else {
                $mmUtil.showErrorModal('mma.mod_forum.errorgetforum', true);
            }
            $scope.canLoadMore = false; // Set to false to prevent infinite calls with infinite-loading.
            return $q.reject();
        });
    }

    // Convenience function to get forum discussions.
    function fetchDiscussions(refresh) {
        if (refresh) {
            page = 0;
        }

        return $mmaModForum.getDiscussions(forum.id, page).then(function(response) {
            var promise = usesGroups ?
                    $mmaModForum.formatDiscussionsGroups(forum.cmid, response.discussions) : $q.when(response.discussions);
            return promise.then(function(discussions) {
                if (page == 0) {
                    $scope.discussions = discussions;
                } else {
                    $scope.discussions = $scope.discussions.concat(discussions);
                }

                $scope.count = $scope.discussions.length;
                $scope.canLoadMore = response.canLoadMore;
                page++;

                // Check if there are replies for discussions stored in offline.
                return $mmaModForumOffline.hasForumReplies(forum.id).then(function(hasOffline) {
                    var offlinePromises = [];
                    $scope.hasOffline = $scope.hasOffline || hasOffline;

                    if (hasOffline) {
                        // Only update new fetched discussions.
                        angular.forEach(discussions, function(discussion) {
                            // Get offline discussions.
                            offlinePromises.push($mmaModForumOffline.getDiscussionReplies(discussion.discussion).then(function(replies) {
                                discussion.numreplies = parseInt(discussion.numreplies, 10) + parseInt(replies.length, 10);
                            }));
                        });
                    }
                    return $q.all(offlinePromises);
                });
            });
        }, function(message) {
            $mmUtil.showErrorModal(message);
            $scope.canLoadMore = false; // Set to false to prevent infinite calls with infinite-loading.
            return $q.reject();
        });
    }

    $scope.sync = function() {
        var modal = $mmUtil.showModalLoading('mm.settings.synchronizing', true);
        syncForum(true).then(function(updated) {
            if (updated) {
                // Refresh the data.
                $scope.discussionsLoaded = false;
                $scope.refreshIcon = 'spinner';
                scrollTop();
                refreshData(false).finally(function() {
                    $scope.discussionsLoaded = true;
                    $scope.refreshIcon = 'ion-refresh';
                });
            }
        }).finally(function() {
            modal.dismiss();
        });
    };

    // Tries to synchronize the forum.
    function syncForum(showErrors) {
        var promises = [];
        promises.push($mmaModForumSync.syncForumDiscussions(forum.id).then(function(result) {
            if (result.warnings && result.warnings.length) {
                $mmUtil.showErrorModal(result.warnings[0]);
            }

            return result.updated;
        }));

        promises.push($mmaModForumSync.syncForumReplies(forum.id).then(function(result) {
            if (result.warnings && result.warnings.length) {
                $mmUtil.showErrorModal(result.warnings[0]);
            }

            if (result && result.updated) {
                // Sync successful, send event.
                $mmEvents.trigger(mmaModForumManualSyncedEvent, {
                    siteid: $mmSite.getId(),
                    forumid: forum.id,
                    userid: $mmSite.getUserId(),
                    warnings: result.warnings
                });
            }

            return result.updated;
        }));

        return $q.all(promises).then(function(results) {
            return results.reduce(function(a, b) {
                return a || b;
            }, false);
        }).catch(function(error) {
            if (showErrors) {
                if (error) {
                    $mmUtil.showErrorModal(error);
                } else {
                    $mmUtil.showErrorModal('mm.core.errorsync', true);
                }
            }
            return $q.reject();
        });
    }

    function scrollTop() {
        if (!scrollView) {
            scrollView = $ionicScrollDelegate.$getByHandle('mmaModForumDiscussionsScroll');
        }
        scrollView && scrollView.scrollTop && scrollView.scrollTop();
    }

    // Refresh forum data and discussions list.
    function refreshData(sync) {
        var promises = [];
        promises.push($mmaModForum.invalidateForumData(courseid));
        if (forum) {
            promises.push($mmaModForum.invalidateDiscussionsList(forum.id));
            promises.push($mmGroups.invalidateActivityGroupMode(forum.cmid));
        }
        return $q.all(promises).finally(function() {
            return fetchForumDataAndDiscussions(true, sync);
        });
    }

    // Function called when we receive an event of new discussion or reply to discussion.
    function eventReceived(data) {
        if ((forum && forum.id === data.forumid) || data.cmid === module.id) {
            if ($ionicPlatform.isTablet()) {
                scrollTop();
            } else {
                // We can't scroll top inmediately because the scroll is not seen.
                shouldScrollTop = true;
            }
            $scope.discussionsLoaded = false;
            $scope.refreshIcon = 'spinner';
            refreshData(false).finally(function() {
                $scope.refreshIcon = 'ion-refresh';
                $scope.discussionsLoaded = true;
            });
            // Check completion since it could be configured to complete once the user adds a new discussion or replies.
            $mmCourse.checkModuleCompletion(courseid, module.completionstatus);
        }
    }

    fetchForumDataAndDiscussions(false, true).then(function() {
        $mmaModForum.logView(forum.id).then(function() {
            $mmCourse.checkModuleCompletion(courseid, module.completionstatus);
        });
    }).finally(function() {
        $scope.refreshIcon = 'ion-refresh';
        $scope.discussionsLoaded = true;
    });

    // Load more discussions.
    $scope.loadMoreDiscussions = function() {
        fetchDiscussions().finally(function() {
            $scope.$broadcast('scroll.infiniteScrollComplete');
        });
    };

    // Pull to refresh.
    $scope.refreshDiscussions = function() {
        if ($scope.discussionsLoaded) {
            $scope.refreshIcon = 'spinner';
            return refreshData(true).finally(function() {
                $scope.discussionsLoaded = true;
                $scope.refreshIcon = 'ion-refresh';
                $scope.$broadcast('scroll.refreshComplete');
            });
        }
    };

    // Context Menu Description action.
    $scope.expandDescription = function() {
        $mmText.expandText($translate.instant('mm.core.description'), $scope.description, false, mmaModForumComponent, module.id);
    };

    // Refresh data if this forum is synchronized automatically.
    syncObserver = $mmEvents.on(mmaModForumAutomSyncedEvent, function(data) {
        if (forum && data && data.siteid == $mmSite.getId() && data.forumid == forum.id && data.userid == $mmSite.getUserId()) {
            // Refresh the data.
            $scope.discussionsLoaded = false;
            $scope.refreshIcon = 'spinner';
            scrollTop();
            refreshData(false).finally(function() {
                $scope.discussionsLoaded = true;
                $scope.refreshIcon = 'ion-refresh';
            });
        }
    });

    // Listen for discussions added. When a discussion is added, we reload the data.
    obsNewDisc = $mmEvents.on(mmaModForumNewDiscussionEvent, eventReceived);
    obsReply = $mmEvents.on(mmaModForumReplyDiscussionEvent, eventReceived);

    // Scroll top if needed.
    $scope.$on('$ionicView.enter', function() {
        if (shouldScrollTop) {
            shouldScrollTop = false;
            scrollTop();
        }
    });

    $scope.$on('$destroy', function(){
        obsNewDisc && obsNewDisc.off && obsNewDisc.off();
        obsReply && obsReply.off && obsReply.off();
        syncObserver && syncObserver.off && syncObserver.off();
    });
});
