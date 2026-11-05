from django.urls import path
from . import views

urlpatterns = [
    # UI Views
    path('', views.studio_view, name='studio'),
    path('<int:project_id>/', views.studio_view, name='studio_project'),

    # API Endpoints
    path('api/project/<int:project_id>/delete/', views.delete_project_api, name='api_delete_project'),
    path('api/projects/', views.api_list_projects, name='api_list_projects'),
    path('api/project/save/', views.save_project_api, name='api_save_new'),
    path('api/project/<int:project_id>/', views.load_project_api, name='api_load_project'),
    path('api/project/<int:project_id>/save/', views.save_project_api, name='api_save_existing'),

    path('<int:project_id>/', views.studio_view, name='studio_project'),
]